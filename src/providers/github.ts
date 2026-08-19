import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';
import type { BatchComment, PrProvider } from './types.js';
import { withRetry } from '../util/retry.js';
import { execErrorDetail } from '../util/exec-error.js';
import { parseHttpUrl } from '../util/url.js';

const CLOUD_API = 'https://api.github.com';

function isCloudHost(host: string): boolean {
  return host === 'github.com' || host === 'www.github.com';
}

/**
 * Token resolution is host-scoped. github.com uses the usual env vars; a GHES
 * host deliberately does NOT fall back to them — a github.com token sent to an
 * enterprise host is the silent-wrong-token bug, and worse, the --detach
 * pre-flight would vouch for that credential in the foreground only for the
 * detached child to die on `401 Bad credentials` minutes later. GHES follows
 * gh's own convention: GH_ENTERPRISE_TOKEN / GITHUB_ENTERPRISE_TOKEN, then
 * `gh auth token --hostname <host>` (gh stores per-hostname tokens; without
 * --hostname it hands back the github.com one). Exported for tests; `exec` is
 * the subprocess seam.
 */
export function resolveToken(host: string, exec: typeof execFileSync = execFileSync): string {
  const cloud = isCloudHost(host);
  const fromEnv = cloud
    ? (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN)
    : (process.env.GH_ENTERPRISE_TOKEN ?? process.env.GITHUB_ENTERPRISE_TOKEN);
  if (fromEnv) return fromEnv;
  let detail: string;
  try {
    const args = cloud ? ['auth', 'token'] : ['auth', 'token', '--hostname', host];
    const token = exec('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    // Guard the empty-but-exit-0 case (broken keyring/hosts.yml state): an
    // empty token must throw here — returning '' would make authEnv() inject
    // an empty token and the detached child would silently fall through to
    // this same flaky CLI fallback the pre-flight exists to avoid.
    if (token) return token;
    detail = '`gh auth token` printed an empty token';
  } catch (e) {
    detail = `\`gh auth token\` failed: ${execErrorDetail(e)}`;
  }
  throw new Error(
    cloud
      ? `No GitHub auth token available (${detail}). Set GITHUB_TOKEN env var or run \`gh auth login\`.`
      : `No GitHub token for ${host} (${detail}). Set GH_ENTERPRISE_TOKEN or run \`gh auth login --hostname ${host}\` — github.com env tokens are deliberately not sent to enterprise hosts.`,
  );
}

function classifyAuthor(login: string): ExistingComment['source'] {
  const l = login.toLowerCase();
  if (l.includes('copilot') || l === 'copilot[bot]') return 'copilot';
  if (l.endsWith('[bot]')) return 'bot';
  if (l.match(/^github-actions/)) return 'bot';
  return 'human';
}

/**
 * GitHub's PR write endpoints rate-limit bursts as a generic 422
 * ("could not be resolved" / pull_request_review_thread.line) instead of 429,
 * and secondary rate limits arrive as 403s. Both recover on backoff.
 */
export function isTransientGitHubError(err: Error): boolean {
  const status = (err as { status?: number }).status;
  const msg = err.message;
  if (status !== undefined && status >= 500) return true;
  if (status === 403 && /rate limit|secondary/i.test(msg)) return true;
  if (status === 422 || /HTTP 422|Validation Failed/i.test(msg)) {
    return /could not be resolved/i.test(msg) || /pull_request_review_thread\.line/i.test(msg);
  }
  return false;
}

export function parseGitHubUrl(url: string): PrRef | null {
  const u = parseHttpUrl(url);
  if (!u) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg.length < 4 || seg[2]!.toLowerCase() !== 'pull' || !/^\d+$/.test(seg[3]!)) return null;
  return {
    provider: 'github',
    url,
    owner: seg[0]!,
    repo: seg[1]!,
    number: parseInt(seg[3]!, 10),
    // GHES serves its REST API under /api/v3 (cloud uses api.github.com).
    baseUrl: isCloudHost(u.hostname) ? CLOUD_API : `${u.protocol}//${u.host}/api/v3`,
  };
}

/**
 * API base for a ref: parseUrl always sets baseUrl, but old serialized refs
 * (pre-0.5.0 caches replayed by --resume) lack it — re-derive from ref.url,
 * with the cloud API as the last resort for hand-built refs. Exported for tests.
 */
export function apiBaseFor(ref: PrRef): string {
  return ref.baseUrl ?? parseGitHubUrl(ref.url)?.baseUrl ?? CLOUD_API;
}

export class GitHubProvider implements PrProvider {
  readonly name = 'github' as const;
  private clients: Map<string, Octokit> = new Map();

  authEnv(ref: PrRef): Record<string, string> {
    const host = new URL(ref.url).hostname;
    const token = resolveToken(host);
    // The round-trip var must match what resolveToken reads back for this
    // host class, so the detached child re-resolves the same credential.
    return isCloudHost(host) ? { GITHUB_TOKEN: token } : { GH_ENTERPRISE_TOKEN: token };
  }

  private client(ref: PrRef): Octokit {
    const baseUrl = apiBaseFor(ref);
    let octokit = this.clients.get(baseUrl);
    if (!octokit) {
      octokit = new Octokit({ auth: resolveToken(new URL(ref.url).hostname), baseUrl });
      this.clients.set(baseUrl, octokit);
    }
    return octokit;
  }

  parseUrl(url: string): PrRef | null {
    return parseGitHubUrl(url);
  }

  async fetchMetadata(ref: PrRef): Promise<PrMetadata> {
    const { data: pr } = await this.client(ref).pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    const linkedIssues = await this.extractLinkedIssues(ref, pr.body ?? '');
    return {
      title: pr.title,
      description: pr.body ?? '',
      author: pr.user?.login ?? '<unknown>',
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      labels: pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
      linkedItems: linkedIssues,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      isDraft: pr.draft ?? false,
      state: pr.merged ? 'merged' : (pr.state as 'open' | 'closed'),
    };
  }

  private async extractLinkedIssues(ref: PrRef, body: string) {
    const issueIds = new Set<string>();
    const re = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) issueIds.add(m[1]);
    const results = await Promise.all(
      [...issueIds].map(async (id) => {
        try {
          const { data: issue } = await this.client(ref).issues.get({
            owner: ref.owner,
            repo: ref.repo,
            issue_number: parseInt(id, 10),
          });
          return {
            type: 'issue' as const,
            id,
            url: issue.html_url,
            title: issue.title,
            state: issue.state,
          };
        } catch (err) {
          // Best-effort, but never silently: reviewers lose linked-issue
          // context when this drops, so say which one and why.
          process.stderr.write(
            `[gather] could not fetch linked issue #${id}: ${(err as Error).message.split('\n')[0]}\n`,
          );
          return null;
        }
      }),
    );
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  async fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    const iterator = this.client(ref).paginate.iterator(this.client(ref).pulls.listFiles, {
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      per_page: 100,
    });
    for await (const { data } of iterator) {
      for (const f of data) {
        files.push({
          path: f.filename,
          status: f.status as ChangedFile['status'],
          previousPath: f.previous_filename,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        });
      }
    }
    return files;
  }

  async fetchFullDiff(ref: PrRef): Promise<string> {
    const { data } = await this.client(ref).pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      mediaType: { format: 'diff' },
    });
    return data as unknown as string;
  }

  async fetchExistingComments(ref: PrRef): Promise<ExistingComment[]> {
    const collectReviewComments = async (): Promise<ExistingComment[]> => {
      const out: ExistingComment[] = [];
      const iter = this.client(ref).paginate.iterator(this.client(ref).pulls.listReviewComments, {
        owner: ref.owner,
        repo: ref.repo,
        pull_number: ref.number,
        per_page: 100,
      });
      for await (const { data } of iter) {
        for (const c of data) {
          const author = c.user?.login ?? '<unknown>';
          out.push({
            id: String(c.id),
            author,
            body: c.body ?? '',
            file: c.path,
            line: c.line ?? c.original_line ?? undefined,
            createdAt: c.created_at,
            source: classifyAuthor(author),
          });
        }
      }
      return out;
    };
    const collectIssueComments = async (): Promise<ExistingComment[]> => {
      const out: ExistingComment[] = [];
      const iter = this.client(ref).paginate.iterator(this.client(ref).issues.listComments, {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
        per_page: 100,
      });
      for await (const { data } of iter) {
        for (const c of data) {
          const author = c.user?.login ?? '<unknown>';
          out.push({
            id: `issue-${c.id}`,
            author,
            body: c.body ?? '',
            createdAt: c.created_at,
            source: classifyAuthor(author),
          });
        }
      }
      return out;
    };
    const [reviewComments, issueComments] = await Promise.all([
      collectReviewComments(),
      collectIssueComments(),
    ]);
    return [...reviewComments, ...issueComments];
  }

  private async resolveHeadSha(ref: PrRef, headSha?: string): Promise<string> {
    if (headSha) return headSha;
    const { data } = await this.client(ref).pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return data.head.sha;
  }

  isTransientError(err: Error): boolean {
    return isTransientGitHubError(err);
  }

  /**
   * ONE attempt, by design. Retrying `createReview` blind is unsafe: a 5xx or
   * timeout can arrive after the review was committed, so a retry either
   * duplicates the review or (as seen in the field) trips the secondary rate
   * limit precisely because the write succeeded. runPost reconciles against
   * the PR and re-issues only what is genuinely missing.
   */
  async postBatchComments(ref: PrRef, headSha: string, comments: BatchComment[]): Promise<{ posted: number }> {
    if (comments.length === 0) return { posted: 0 };
    await this.client(ref).pulls.createReview({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
      commit_id: headSha,
      // COMMENT is the only event acceptable on the author's own PR, and
      // posting findings must never approve/block on their behalf.
      event: 'COMMENT',
      // NO review body: a body renders as an extra "X left a comment" box
      // in the PR timeline on top of the inline comments — pure noise.
      // The API docs claim `body` is required for COMMENT, but that only
      // holds for comment-less reviews; with a populated `comments[]`
      // GitHub accepts the omission (the web UI submits body-less
      // reviews the same way). Findings must only ever appear inline.
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })),
    });
    return { posted: comments.length };
  }

  async postLineComment(ref: PrRef, finding: Finding, headSha?: string): Promise<{ id: string } | null> {
    if (!finding.file || !finding.line) return null;
    const commitId = await this.resolveHeadSha(ref, headSha);
    const body = finding.body.trim();
    // No top-level issue-comment fallback: findings must land as resolvable
    // review threads. An unanchorable finding surfaces as an error instead.
    const { data } = await withRetry(
      () =>
        this.client(ref).pulls.createReviewComment({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          body,
          commit_id: commitId,
          path: finding.file!,
          line: finding.line!,
          side: 'RIGHT',
        }),
      isTransientGitHubError,
      `${finding.file}:${finding.line}`,
    );
    return { id: String(data.id) };
  }
}
