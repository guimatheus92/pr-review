import * as azdev from 'azure-devops-node-api';
import { execFileSync } from 'node:child_process';
import type { GitPullRequest, GitPullRequestCommentThread, Comment } from 'azure-devops-node-api/interfaces/GitInterfaces.js';
import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';
import type { PrProvider } from './types.js';

const URL_RES = [
  /^https?:\/\/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_git\/([^\/]+)\/pullrequest\/(\d+)/i,
  /^https?:\/\/([^.]+)\.visualstudio\.com\/([^\/]+)\/_git\/([^\/]+)\/pullrequest\/(\d+)/i,
];

const ADO_AZURE_AD_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

interface AdoCredential {
  token: string;
  kind: 'pat' | 'bearer';
}

function resolveCredential(): AdoCredential {
  const pat = process.env.AZURE_DEVOPS_PAT ?? process.env.SYSTEM_ACCESSTOKEN ?? process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return { token: pat, kind: 'pat' };
  try {
    const token = execFileSync(
      'az',
      ['account', 'get-access-token', '--resource', ADO_AZURE_AD_RESOURCE_ID, '--query', 'accessToken', '-o', 'tsv'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: process.platform === 'win32',
      },
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

export class AzureDevOpsProvider implements PrProvider {
  readonly name = 'azuredevops' as const;
  private connections: Map<string, azdev.WebApi> = new Map();

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

  private async getPr(ref: PrRef): Promise<GitPullRequest> {
    const conn = this.connection(orgHost(ref.url));
    const git = await conn.getGitApi();
    return git.getPullRequestById(ref.number, ref.project);
  }

  async fetchMetadata(ref: PrRef): Promise<PrMetadata> {
    const pr = await this.getPr(ref);
    const linkedItems: PrMetadata['linkedItems'] = [];
    const conn = this.connection(orgHost(ref.url));
    const git = await conn.getGitApi();
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
    const conn = this.connection(orgHost(ref.url));
    const git = await conn.getGitApi();
    const pr = await git.getPullRequestById(ref.number, ref.project);
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
    const files: ChangedFile[] = [];
    for (const change of changes.changeEntries ?? []) {
      const path = change.item?.path?.replace(/^\//, '') ?? '';
      if (!path) continue;
      const status: ChangedFile['status'] =
        change.changeType === 1
          ? 'added'
          : change.changeType === 2
            ? 'modified'
            : change.changeType === 16
              ? 'deleted'
              : 'modified';
      let patch: string | undefined;
      if (status !== 'deleted' && headSha) {
        const [headContent, baseContent] = await Promise.all([
          this.fetchFileText(git, repoId, ref.project!, path, headSha),
          baseSha && status !== 'added' ? this.fetchFileText(git, repoId, ref.project!, path, baseSha) : Promise.resolve(null),
        ]);
        patch = this.synthesizePatch(path, baseContent, headContent, baseSha ?? '', headSha);
      }
      let additions = 0;
      let deletions = 0;
      if (patch) {
        for (const line of patch.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) additions++;
          else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
        }
      }
      files.push({ path, status, additions, deletions, patch });
    }
    return files;
  }

  private async fetchFileText(
    git: Awaited<ReturnType<azdev.WebApi['getGitApi']>>,
    repoId: string,
    project: string,
    path: string,
    sha: string,
  ): Promise<string | null> {
    try {
      const item = await git.getItem(
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
      );
      const content = (item as unknown as { content?: string }).content;
      return typeof content === 'string' ? content : null;
    } catch {
      return null;
    }
  }

  private synthesizePatch(
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
    const lcs = this.lcsLineDiff(baseLines, headLines);
    const header = `--- a/${path} (${baseSha.slice(0, 12)})\n+++ b/${path} (${headSha.slice(0, 12)})`;
    return `${header}\n${lcs}`;
  }

  private lcsLineDiff(a: string[], b: string[]): string {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) dp[i]![j] = dp[i - 1]![j - 1]! + 1;
        else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
    const out: string[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        out.push(` ${a[i - 1]}`);
        i--;
        j--;
      } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
        out.push(`-${a[i - 1]}`);
        i--;
      } else {
        out.push(`+${b[j - 1]}`);
        j--;
      }
    }
    while (i > 0) {
      out.push(`-${a[--i]}`);
    }
    while (j > 0) {
      out.push(`+${b[--j]}`);
    }
    return out.reverse().join('\n');
  }

  async fetchFullDiff(ref: PrRef): Promise<string> {
    const conn = this.connection(orgHost(ref.url));
    const git = await conn.getGitApi();
    const pr = await git.getPullRequestById(ref.number, ref.project);
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
    } catch {
      return '';
    }
  }

  async fetchExistingComments(ref: PrRef): Promise<ExistingComment[]> {
    const conn = this.connection(orgHost(ref.url));
    const git = await conn.getGitApi();
    const pr = await git.getPullRequestById(ref.number, ref.project);
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

  async postLineComment(ref: PrRef, finding: Finding): Promise<{ id: string } | null> {
    const conn = this.connection(orgHost(ref.url));
    const git = await conn.getGitApi();
    const pr = await git.getPullRequestById(ref.number, ref.project);
    const repoId = pr.repository!.id!;
    const body = finding.body.trim();
    if (finding.file && finding.line) {
      const thread: GitPullRequestCommentThread = {
        comments: [{ parentCommentId: 0, content: body, commentType: 1 } as Comment],
        status: 1,
        threadContext: {
          filePath: `/${finding.file.replace(/^\//, '')}`,
          rightFileStart: { line: finding.line, offset: 1 },
          rightFileEnd: { line: finding.line, offset: 1 },
        },
      };
      const created = await git.createThread(thread, repoId, ref.number, ref.project);
      return { id: `${created.id}` };
    }
    const general: GitPullRequestCommentThread = {
      comments: [{ parentCommentId: 0, content: body, commentType: 1 } as Comment],
      status: 1,
    };
    const created = await git.createThread(general, repoId, ref.number, ref.project);
    return { id: `${created.id}` };
  }
}
