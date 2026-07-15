import * as azdev from 'azure-devops-node-api';
import { execFileSync, execSync } from 'node:child_process';
import pLimit from 'p-limit';
import type { GitPullRequest, GitPullRequestCommentThread, Comment } from 'azure-devops-node-api/interfaces/GitInterfaces.js';
import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';
import type { PrProvider } from './types.js';
import { withRetry } from '../util/retry.js';

const URL_RES = [
  /^https?:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+)\/pullrequest\/(\d+)/i,
  /^https?:\/\/([^.]+)\.visualstudio\.com\/([^\/]+)\/_git\/([^\/]+)\/pullrequest\/(\d+)/i,
];

const ADO_AZURE_AD_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

// Concurrent per-file content fetches during diff synthesis.
const FILE_FETCH_CONCURRENCY = 5;

// azure-devops-node-api VersionControlChangeType bit flags. changeType is a
// bitmask, not a single value — an edit arrives OR'd with rename/encoding/etc.
// (e.g. edit|rename = 10) — so mask each bit; equality checks miss combinations.
const VC_ADD = 1;
const VC_RENAME = 8;
const VC_DELETE = 16;

interface AdoCredential {
  token: string;
  kind: 'pat' | 'bearer';
}

function resolveCredential(): AdoCredential {
  const pat = process.env.AZURE_DEVOPS_PAT ?? process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return { token: pat, kind: 'pat' };
  try {
    // az ships as az.cmd on Windows, which only a shell can launch — and
    // shell+args-array trips DEP0190, so win32 gets a prebuilt command string
    // (every part is a static literal, nothing user-controlled). Elsewhere,
    // spawn the binary directly with no shell.
    const argv = ['account', 'get-access-token', '--resource', ADO_AZURE_AD_RESOURCE_ID, '--query', 'accessToken', '-o', 'tsv'];
    const token = (
      process.platform === 'win32'
        ? execSync(['az', ...argv].join(' '), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        : execFileSync('az', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    ).trim();
    if (token) {
      process.stderr.write(`[ado] using bearer token from \`az account get-access-token\`\n`);
      return { token, kind: 'bearer' };
    }
  } catch {
    // fall through
  }
  throw new Error(
    'No Azure DevOps token available. Set AZURE_DEVOPS_PAT, or run `az login` so `az account get-access-token` can mint a bearer token.',
  );
}

function classifyAuthor(displayName: string, uniqueName?: string): ExistingComment['source'] {
  const haystack = `${displayName} ${uniqueName ?? ''}`.toLowerCase();
  if (haystack.includes('copilot')) return 'copilot';
  if (haystack.includes('bot') || haystack.includes('build') || haystack.includes('agent')) return 'bot';
  return 'human';
}

function orgHost(url: string): string {
  const m1 = url.match(/^https?:\/\/dev\.azure\.com\/([^\/]+)/i);
  if (m1) return `https://dev.azure.com/${m1[1]}`;
  const m2 = url.match(/^https?:\/\/([^.]+)\.visualstudio\.com/i);
  if (m2) return `https://${m2[1]}.visualstudio.com`;
  throw new Error(`Unrecognized ADO URL host: ${url}`);
}

/** Exported for tests. azure-devops-node-api surfaces HTTP codes as `statusCode`; check `status` too so a library change cannot silently kill retries. */
export function isTransientAdoError(err: Error): boolean {
  const e = err as { statusCode?: number; status?: number };
  const status = e.statusCode ?? e.status;
  return status === 429 || (status !== undefined && status >= 500);
}

type GitApi = Awaited<ReturnType<azdev.WebApi['getGitApi']>>;

/**
 * Synthesize a unified-diff patch from base/head file contents. Exported for
 * tests: this patch feeds buildValidLinesMap (line snapping) and the reviewer
 * context, so wrong offsets silently snap every ADO finding to a wrong line.
 */
export function synthesizePatch(
  path: string,
  base: string | null,
  head: string | null,
  baseSha: string,
  headSha: string,
): string {
  const baseLines = (base ?? '').split('\n');
  const headLines = (head ?? '').split('\n');
  if (!base && head) {
    return `--- /dev/null\n+++ b/${path} (${headSha.slice(0, 12)})\n${headLines.map((l) => `+${l}`).join('\n')}`;
  }
  if (base && !head) {
    return `--- a/${path} (${baseSha.slice(0, 12)})\n+++ /dev/null\n${baseLines.map((l) => `-${l}`).join('\n')}`;
  }
  const lcs = lcsLineDiff(baseLines, headLines);
  const header = `--- a/${path} (${baseSha.slice(0, 12)})\n+++ b/${path} (${headSha.slice(0, 12)})`;
  return `${header}\n${lcs}`;
}

/** Exported for tests. */
export function lcsLineDiff(a: string[], b: string[]): string {
  // PR edits localize: strip the common prefix/suffix so the O(n²) DP matrix
  // only covers the changed region instead of the whole file.
  let prefix = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(a.length, b.length) - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const coreA = a.slice(prefix, a.length - suffix);
  const coreB = b.slice(prefix, b.length - suffix);

  const m = coreA.length;
  const n = coreB.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (coreA[i - 1] === coreB[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  const core: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (coreA[i - 1] === coreB[j - 1]) {
      core.push(` ${coreA[i - 1]}`);
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      core.push(`-${coreA[i - 1]}`);
      i--;
    } else {
      core.push(`+${coreB[j - 1]}`);
      j--;
    }
  }
  while (i > 0) {
    core.push(`-${coreA[--i]}`);
  }
  while (j > 0) {
    core.push(`+${coreB[--j]}`);
  }
  core.reverse();

  const out: string[] = [
    ...a.slice(0, prefix).map((l) => ` ${l}`),
    ...core,
    ...a.slice(a.length - suffix).map((l) => ` ${l}`),
  ];
  return out.join('\n');
}

/**
 * Map an ADO change entry to its review status and the path its BASE content
 * lives at. `changeType` is a VersionControlChangeType bitmask (edits arrive
 * OR'd with rename/encoding/…), and on a rename the base content is at the OLD
 * path (`sourceServerItem`) — fetching the base at the new path returns a null
 * item and the file wrongly synthesizes as fully-added. Exported so the bitmask
 * + rename handling is unit-testable without the ADO API.
 */
export function classifyChange(
  changeType: number | undefined,
  newPath: string,
  sourceServerItem: string | undefined,
): { status: ChangedFile['status']; basePath: string } {
  const ct = changeType ?? 0;
  const status: ChangedFile['status'] =
    (ct & VC_DELETE) !== 0 ? 'deleted' : (ct & VC_ADD) !== 0 ? 'added' : 'modified';
  const basePath =
    (ct & VC_RENAME) !== 0 ? sourceServerItem?.replace(/^\//, '') || newPath : newPath;
  return { status, basePath };
}

export class AzureDevOpsProvider implements PrProvider {
  readonly name = 'azuredevops' as const;
  private connections: Map<string, azdev.WebApi> = new Map();
  private gitApis: Map<string, Promise<GitApi>> = new Map();
  private prCache: Map<string, Promise<GitPullRequest>> = new Map();

  private connection(orgUrl: string): azdev.WebApi {
    const cached = this.connections.get(orgUrl);
    if (cached) return cached;
    const cred = resolveCredential();
    const handler =
      cred.kind === 'bearer'
        ? azdev.getBearerHandler(cred.token)
        : azdev.getPersonalAccessTokenHandler(cred.token);
    const conn = new azdev.WebApi(orgUrl, handler);
    this.connections.set(orgUrl, conn);
    return conn;
  }

  private gitApi(ref: PrRef): Promise<GitApi> {
    const orgUrl = orgHost(ref.url);
    let api = this.gitApis.get(orgUrl);
    if (!api) {
      api = this.connection(orgUrl).getGitApi();
      this.gitApis.set(orgUrl, api);
    }
    return api;
  }

  parseUrl(url: string): PrRef | null {
    for (const re of URL_RES) {
      const m = url.match(re);
      if (!m) continue;
      return {
        provider: 'azuredevops',
        url,
        organization: m[1],
        project: m[2],
        owner: m[1]!,
        repo: m[3]!,
        number: parseInt(m[4]!, 10),
      };
    }
    return null;
  }

  /** One PR fetch per (url, number) for the provider instance's lifetime — posting N findings must not re-fetch N times. */
  private getPr(ref: PrRef): Promise<GitPullRequest> {
    const key = `${orgHost(ref.url)}#${ref.project}#${ref.number}`;
    let pr = this.prCache.get(key);
    if (!pr) {
      pr = this.gitApi(ref).then((git) => git.getPullRequestById(ref.number, ref.project));
      this.prCache.set(key, pr);
    }
    return pr;
  }

  async fetchMetadata(ref: PrRef): Promise<PrMetadata> {
    const pr = await this.getPr(ref);
    const linkedItems: PrMetadata['linkedItems'] = [];
    const git = await this.gitApi(ref);
    try {
      const work = await git.getPullRequestWorkItemRefs(pr.repository!.id!, pr.pullRequestId!, ref.project);
      for (const w of work ?? []) {
        linkedItems.push({
          type: 'workitem',
          id: String(w.id),
          url: w.url ?? '',
        });
      }
    } catch {
      // best-effort
    }
    return {
      title: pr.title ?? '',
      description: pr.description ?? '',
      author: pr.createdBy?.displayName ?? '<unknown>',
      headSha: pr.lastMergeSourceCommit?.commitId ?? '',
      baseSha: pr.lastMergeTargetCommit?.commitId ?? '',
      headBranch: (pr.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      baseBranch: (pr.targetRefName ?? '').replace(/^refs\/heads\//, ''),
      labels: (pr.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
      linkedItems,
      createdAt: pr.creationDate?.toISOString?.() ?? new Date().toISOString(),
      updatedAt: pr.creationDate?.toISOString?.() ?? new Date().toISOString(),
      isDraft: pr.isDraft ?? false,
      state: pr.status === 3 ? 'merged' : pr.status === 2 ? 'closed' : 'open',
    };
  }

  async fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]> {
    const git = await this.gitApi(ref);
    const pr = await this.getPr(ref);
    const repoId = pr.repository!.id!;
    const headSha = pr.lastMergeSourceCommit?.commitId;
    const baseSha = pr.lastMergeTargetCommit?.commitId;
    const iterations = await git.getPullRequestIterations(repoId, ref.number, ref.project);
    const latest = iterations[iterations.length - 1];
    if (!latest) return [];
    const changes = await git.getPullRequestIterationChanges(
      repoId,
      ref.number,
      latest.id!,
      ref.project,
    );
    const limit = pLimit(FILE_FETCH_CONCURRENCY);
    const results = await Promise.all(
      (changes.changeEntries ?? []).map((change) =>
        limit(async (): Promise<ChangedFile | null> => {
          const path = change.item?.path?.replace(/^\//, '') ?? '';
          if (!path) return null;
          const { status, basePath } = classifyChange(
            change.changeType,
            path,
            (change as { sourceServerItem?: string }).sourceServerItem,
          );
          let patch: string | undefined;
          if (status !== 'deleted' && headSha) {
            const [headContent, baseContent] = await Promise.all([
              this.fetchFileText(git, repoId, ref.project!, path, headSha),
              baseSha && status !== 'added'
                ? this.fetchFileText(git, repoId, ref.project!, basePath, baseSha)
                : Promise.resolve(null),
            ]);
            patch = synthesizePatch(path, baseContent, headContent, baseSha ?? '', headSha);
          }
          let additions = 0;
          let deletions = 0;
          if (patch) {
            for (const line of patch.split('\n')) {
              if (line.startsWith('+') && !line.startsWith('+++')) additions++;
              else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }
          }
          return { path, status, additions, deletions, patch };
        }),
      ),
    );
    return results.filter((f): f is ChangedFile => f !== null);
  }

  private async fetchFileText(
    git: GitApi,
    repoId: string,
    project: string,
    path: string,
    sha: string,
  ): Promise<string | null> {
    try {
      const item = await withRetry(
        () =>
          git.getItem(
            repoId,
            `/${path}`,
            project,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { version: sha, versionType: 2 },
            true,
            false,
          ),
        isTransientAdoError,
        `getItem ${path}@${sha.slice(0, 8)}`,
      );
      // getItem yields a null item for a path absent at this version instead of
      // throwing; reading `.content` off null would throw a misleading
      // "Cannot read properties of null" that surfaces as a bogus fetch failure.
      if (item == null) return null;
      const content = (item as unknown as { content?: string }).content;
      return typeof content === 'string' ? content : null;
    } catch (err) {
      // A null here makes synthesizePatch treat the file as added/deleted —
      // a wrong diff on a transient failure would be silent, so say it loud.
      process.stderr.write(
        `[ado] could not fetch ${path} at ${sha.slice(0, 8)} (${(err as Error).message.split('\n')[0]}); diff for this file may be wrong\n`,
      );
      return null;
    }
  }

  async fetchFullDiff(ref: PrRef): Promise<string> {
    const git = await this.gitApi(ref);
    const pr = await this.getPr(ref);
    const sourceSha = pr.lastMergeSourceCommit?.commitId;
    const targetSha = pr.lastMergeTargetCommit?.commitId;
    if (!sourceSha || !targetSha) return '';
    try {
      const diffs = await git.getCommitDiffs(
        pr.repository!.id!,
        ref.project,
        false,
        undefined,
        undefined,
        { baseVersion: targetSha, baseVersionType: 2 },
        { targetVersion: sourceSha, targetVersionType: 2 },
      );
      return JSON.stringify(diffs.changes ?? [], null, 2);
    } catch (err) {
      process.stderr.write(`[ado] getCommitDiffs failed (${(err as Error).message.split('\n')[0]}); full diff omitted from context\n`);
      return '';
    }
  }

  async fetchExistingComments(ref: PrRef): Promise<ExistingComment[]> {
    const git = await this.gitApi(ref);
    const pr = await this.getPr(ref);
    const threads = await git.getThreads(pr.repository!.id!, ref.number, ref.project);
    const out: ExistingComment[] = [];
    for (const t of threads ?? []) {
      const file = t.threadContext?.filePath?.replace(/^\//, '');
      const line = t.threadContext?.rightFileStart?.line;
      for (const c of t.comments ?? []) {
        const author = c.author?.displayName ?? '<unknown>';
        out.push({
          id: `${t.id}-${c.id}`,
          author,
          body: c.content ?? '',
          file,
          line,
          createdAt: c.publishedDate?.toISOString?.() ?? new Date().toISOString(),
          source: classifyAuthor(author, c.author?.uniqueName ?? undefined),
        });
      }
    }
    return out;
  }

  async postLineComment(ref: PrRef, finding: Finding, _headSha?: string): Promise<{ id: string } | null> {
    const git = await this.gitApi(ref);
    const pr = await this.getPr(ref);
    const repoId = pr.repository!.id!;
    const body = finding.body.trim();
    const thread: GitPullRequestCommentThread =
      finding.file && finding.line
        ? {
            comments: [{ parentCommentId: 0, content: body, commentType: 1 } as Comment],
            status: 1,
            threadContext: {
              filePath: `/${finding.file.replace(/^\//, '')}`,
              rightFileStart: { line: finding.line, offset: 1 },
              rightFileEnd: { line: finding.line, offset: 1 },
            },
          }
        : {
            comments: [{ parentCommentId: 0, content: body, commentType: 1 } as Comment],
            status: 1,
          };
    const created = await withRetry(
      () => git.createThread(thread, repoId, ref.number, ref.project),
      isTransientAdoError,
      finding.file ? `${finding.file}:${finding.line ?? '-'}` : 'general comment',
    );
    return { id: `${created.id}` };
  }
}
