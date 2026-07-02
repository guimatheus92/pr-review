import { Octokit } from '@octokit/rest';
import { execFileSync } from 'node:child_process';
import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';
import type { BatchComment, PrProvider } from './types.js';
import { withRetry } from '../util/retry.js';

const URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/i;

function resolveToken(): string {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.COPILOT_GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(
      'No GitHub auth token available. Set GITHUB_TOKEN env var or run `gh auth login`.',
    );
  }
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

export class GitHubProvider implements PrProvider {
  readonly name = 'github' as const;
  private octokit: Octokit | null = null;

  private client(): Octokit {
    if (!this.octokit) {
      this.octokit = new Octokit({ auth: resolveToken() });
    }
    return this.octokit;
  }

  parseUrl(url: string): PrRef | null {
    const m = url.match(URL_RE);
    if (!m) return null;
    return {
      provider: 'github',
      url,
      owner: m[1],
      repo: m[2],
      number: parseInt(m[3], 10),
    };
  }

  async fetchMetadata(ref: PrRef): Promise<PrMetadata> {
    const { data: pr } = await this.client().pulls.get({
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
          const { data: issue } = await this.client().issues.get({
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
        } catch {
          return null; // Best-effort
        }
      }),
    );
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  }

  async fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]> {
    const files: ChangedFile[] = [];
    const iterator = this.client().paginate.iterator(this.client().pulls.listFiles, {
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
    const { data } = await this.client().pulls.get({
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
      const iter = this.client().paginate.iterator(this.client().pulls.listReviewComments, {
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
      const iter = this.client().paginate.iterator(this.client().issues.listComments, {
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
    const { data } = await this.client().pulls.get({
      owner: ref.owner,
      repo: ref.repo,
      pull_number: ref.number,
    });
    return data.head.sha;
  }

  async postBatchComments(ref: PrRef, headSha: string, comments: BatchComment[]): Promise<{ posted: number }> {
    if (comments.length === 0) return { posted: 0 };
    await withRetry(
      () =>
        this.client().pulls.createReview({
          owner: ref.owner,
          repo: ref.repo,
          pull_number: ref.number,
          commit_id: headSha,
          // COMMENT is the only event acceptable on the author's own PR, and
          // posting findings must never approve/block on their behalf.
          event: 'COMMENT',
          body: 'Automated review findings.',
          comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT' as const, body: c.body })),
        }),
      isTransientGitHubError,
      `review batch (${comments.length} comments)`,
    );
    return { posted: comments.length };
  }

  async postLineComment(ref: PrRef, finding: Finding, headSha?: string): Promise<{ id: string } | null> {
    if (!finding.file || !finding.line) return null;
    const commitId = await this.resolveHeadSha(ref, headSha);
    const body = finding.body.trim();
    try {
      const { data } = await withRetry(
        () =>
          this.client().pulls.createReviewComment({
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
    } catch (err) {
      const issueBody = `\`${finding.file}:${finding.line}\` — ${finding.body.trim()}`;
      const { data } = await this.client().issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
        body: issueBody,
      });
      return { id: `issue-${data.id}` };
    }
  }
}
