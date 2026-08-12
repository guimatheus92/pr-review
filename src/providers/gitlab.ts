import { execFileSync } from 'node:child_process';
import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';
import type { PrProvider } from './types.js';
import { withRetry } from '../util/retry.js';
import { execErrorDetail } from '../util/exec-error.js';

// Modern (/-/merge_requests/) and legacy (no /-/) forms, any host, nested
// namespaces (group/subgroup/project). Trailing /diffs, query, #note_x fall
// off after the iid digits.
const URL_RE = /^https?:\/\/[^\/]+\/(.+?)\/(?:-\/)?merge_requests\/(\d+)/i;

function resolveToken(host: string): string {
  const fromEnv = process.env.GITLAB_TOKEN ?? process.env.GITLAB_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  let detail: string;
  try {
    const token = execFileSync('glab', ['config', 'get', 'token', '-h', host], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    // glab's keyring-backed storage can print an empty token with exit 0 —
    // same guard as github.ts: an empty token must throw here, or authEnv()
    // would inject GITLAB_TOKEN='' into the detached child.
    if (token) return token;
    detail = '`glab config get token` printed an empty token';
  } catch (e) {
    detail = `\`glab config get token\` failed: ${execErrorDetail(e)}`;
  }
  throw new Error(
    `No GitLab token available (${detail}). Set GITLAB_TOKEN env var or run \`glab auth login\`.`,
  );
}

/** Exported for tests. */
export function classifyAuthor(username: string): ExistingComment['source'] {
  const u = username.toLowerCase();
  if (u.includes('copilot')) return 'copilot';
  // project_42_bot_abc / group_1_bot: GitLab's generated bot accounts.
  if (/^(project|group)_\d+_bot/.test(u)) return 'bot';
  if (/(^|[_-])bot([_\-\d]|$)/.test(u) || u === 'ghost') return 'bot';
  return 'human';
}

/** Exported for tests. GitLab rate-limits as 429 (+ Retry-After); 5xx recover on backoff. */
export function isTransientGitLabError(err: Error): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || (status !== undefined && status >= 500);
}

interface GitLabDiff {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

interface GitLabMr {
  iid: number;
  title: string;
  description: string | null;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  author?: { username?: string };
  source_branch: string;
  target_branch: string;
  labels: string[];
  sha: string;
  diff_refs?: { base_sha: string; head_sha: string; start_sha: string } | null;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  work_in_progress?: boolean;
}

interface GitLabNote {
  id: number;
  body: string;
  system: boolean;
  author?: { username?: string };
  created_at: string;
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
}

/** Exported for tests. GitLab's `diff` field is hunks-only (`@@ …`) — the same shape Octokit's `patch` has, so line snapping works unchanged. */
export function mapDiff(d: GitLabDiff): ChangedFile {
  let additions = 0;
  let deletions = 0;
  for (const ln of (d.diff ?? '').split('\n')) {
    if (ln.startsWith('+') && !ln.startsWith('+++')) additions++;
    else if (ln.startsWith('-') && !ln.startsWith('---')) deletions++;
  }
  return {
    path: d.new_path,
    status: d.new_file ? 'added' : d.deleted_file ? 'deleted' : d.renamed_file ? 'renamed' : 'modified',
    previousPath: d.renamed_file ? d.old_path : undefined,
    additions,
    deletions,
    patch: d.diff || undefined,
  };
}

/** Exported for tests. GitLab has no single-blob MR diff endpoint; the full diff is the per-file diffs concatenated with git-style headers. */
export function buildFullDiff(diffs: GitLabDiff[]): string {
  return diffs
    .map((d) => {
      const oldSide = d.new_file ? '/dev/null' : `a/${d.old_path}`;
      const newSide = d.deleted_file ? '/dev/null' : `b/${d.new_path}`;
      return `diff --git a/${d.old_path} b/${d.new_path}\n--- ${oldSide}\n+++ ${newSide}\n${d.diff ?? ''}`;
    })
    .join('\n');
}

/**
 * Position math for inline discussions — the crux of GitLab posting. A
 * discussion position on an ADDED line carries `new_line` only; on a CONTEXT
 * line it MUST also carry the matching `old_line`, or the API rejects it with
 * the notorious 400 "position is invalid". Walks the hunks tracking both
 * cursors. Returns null when the line is not in the patch. Exported for
 * tests: wrong math here silently mis-anchors every GitLab finding.
 */
export function positionForLine(patch: string, target: number): { newLine: number; oldLine?: number } | null {
  let oldLine = 0;
  let newLine = 0;
  for (const ln of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (m) {
      oldLine = parseInt(m[1]!, 10) - 1;
      newLine = parseInt(m[2]!, 10) - 1;
      continue;
    }
    if (ln.startsWith('+++') || ln.startsWith('---') || ln.startsWith('\\')) continue;
    if (ln.startsWith('+')) {
      newLine++;
      if (newLine === target) return { newLine: target };
    } else if (ln.startsWith('-')) {
      oldLine++;
    } else {
      oldLine++;
      newLine++;
      if (newLine === target) return { newLine: target, oldLine };
    }
  }
  return null;
}

export class GitLabProvider implements PrProvider {
  readonly name = 'gitlab' as const;
  /** One MR/diffs fetch per (host, project, iid) for the instance's lifetime — posting N findings must not re-fetch N times. */
  private mrCache: Map<string, Promise<GitLabMr>> = new Map();
  private diffsCache: Map<string, Promise<GitLabDiff[]>> = new Map();

  authEnv(ref?: PrRef): Record<string, string> {
    const host = ref ? new URL(ref.url).host : 'gitlab.com';
    return { GITLAB_TOKEN: resolveToken(host) };
  }

  parseUrl(url: string): PrRef | null {
    const m = url.match(URL_RE);
    if (!m) return null;
    const parts = m[1]!.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2) return null;
    return {
      provider: 'gitlab',
      url,
      // Nested namespaces keep their slashes: owner is the full group path.
      owner: parts.slice(0, -1).join('/'),
      repo: parts[parts.length - 1]!,
      number: parseInt(m[2]!, 10),
      baseUrl: `${new URL(url).origin}/api/v4`,
    };
  }

  private projectBase(ref: PrRef): string {
    const api = ref.baseUrl ?? `${new URL(ref.url).origin}/api/v4`;
    return `${api}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`;
  }

  private async api<T>(ref: PrRef, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await this.rawFetch(ref, `${this.projectBase(ref)}${path}`, init);
    return (await res.json()) as T;
  }

  private async rawFetch(ref: PrRef, url: string, init?: { method?: string; body?: unknown }): Promise<Response> {
    const token = resolveToken(new URL(ref.url).host);
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        // Bearer works for both PATs and glab's OAuth tokens; PRIVATE-TOKEN
        // rejects OAuth tokens.
        authorization: `Bearer ${token}`,
        ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw Object.assign(new Error(`GitLab API ${res.status} on ${new URL(url).pathname}: ${text.slice(0, 500)}`), {
        status: res.status,
      });
    }
    return res;
  }

  private async apiAll<T>(ref: PrRef, path: string): Promise<T[]> {
    const out: T[] = [];
    let page = '1';
    while (page) {
      const sep = path.includes('?') ? '&' : '?';
      const res = await this.rawFetch(ref, `${this.projectBase(ref)}${path}${sep}per_page=100&page=${page}`);
      out.push(...((await res.json()) as T[]));
      page = res.headers.get('x-next-page') ?? '';
    }
    return out;
  }

  private cacheKey(ref: PrRef): string {
    return `${new URL(ref.url).origin}#${ref.owner}/${ref.repo}#${ref.number}`;
  }

  private getMr(ref: PrRef): Promise<GitLabMr> {
    const key = this.cacheKey(ref);
    let mr = this.mrCache.get(key);
    if (!mr) {
      mr = this.api<GitLabMr>(ref, `/merge_requests/${ref.number}`);
      this.mrCache.set(key, mr);
    }
    return mr;
  }

  private getDiffs(ref: PrRef): Promise<GitLabDiff[]> {
    const key = this.cacheKey(ref);
    let diffs = this.diffsCache.get(key);
    if (!diffs) {
      diffs = this.apiAll<GitLabDiff>(ref, `/merge_requests/${ref.number}/diffs`);
      this.diffsCache.set(key, diffs);
    }
    return diffs;
  }

  async fetchMetadata(ref: PrRef): Promise<PrMetadata> {
    const mr = await this.getMr(ref);
    const linkedItems: PrMetadata['linkedItems'] = [];
    try {
      const issues = await this.apiAll<{ iid: number; web_url?: string; title?: string; state?: string }>(
        ref,
        `/merge_requests/${ref.number}/closes_issues`,
      );
      for (const i of issues) {
        linkedItems.push({ type: 'issue', id: String(i.iid), url: i.web_url ?? '', title: i.title, state: i.state });
      }
    } catch (err) {
      // Best-effort, but never silently: reviewers lose linked-issue context.
      process.stderr.write(
        `[gather] could not fetch linked issues: ${(err as Error).message.split('\n')[0]}\n`,
      );
    }
    return {
      title: mr.title,
      description: mr.description ?? '',
      author: mr.author?.username ?? '<unknown>',
      headSha: mr.diff_refs?.head_sha ?? mr.sha,
      baseSha: mr.diff_refs?.base_sha ?? '',
      headBranch: mr.source_branch,
      baseBranch: mr.target_branch,
      labels: mr.labels ?? [],
      linkedItems,
      createdAt: mr.created_at,
      updatedAt: mr.updated_at,
      isDraft: mr.draft ?? mr.work_in_progress ?? false,
      state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
    };
  }

  async fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]> {
    return (await this.getDiffs(ref)).map(mapDiff);
  }

  async fetchFullDiff(ref: PrRef): Promise<string> {
    return buildFullDiff(await this.getDiffs(ref));
  }

  async fetchExistingComments(ref: PrRef): Promise<ExistingComment[]> {
    const notes = await this.apiAll<GitLabNote>(ref, `/merge_requests/${ref.number}/notes`);
    return notes
      .filter((n) => !n.system)
      .map((n) => {
        const author = n.author?.username ?? '<unknown>';
        return {
          id: String(n.id),
          author,
          body: n.body ?? '',
          file: n.position?.new_path ?? n.position?.old_path ?? undefined,
          line: n.position?.new_line ?? n.position?.old_line ?? undefined,
          createdAt: n.created_at,
          source: classifyAuthor(author),
        };
      });
  }

  async postLineComment(ref: PrRef, finding: Finding, _headSha?: string): Promise<{ id: string } | null> {
    if (!finding.file || !finding.line) return null;
    // Position SHAs must match the MR's recorded diff version, so the gather
    // headSha param is deliberately ignored — a stale value 400s the post.
    const mr = await this.getMr(ref);
    if (!mr.diff_refs) {
      throw new Error(`MR !${ref.number} has no diff_refs — cannot anchor an inline discussion`);
    }
    const diff = (await this.getDiffs(ref)).find((d) => d.new_path === finding.file);
    const pos = diff?.diff ? positionForLine(diff.diff, finding.line) : null;
    const position: Record<string, unknown> = {
      position_type: 'text',
      base_sha: mr.diff_refs.base_sha,
      start_sha: mr.diff_refs.start_sha,
      head_sha: mr.diff_refs.head_sha,
      // old_path is required even for new-side comments; on a rename it must
      // be the real old path or the API 400s.
      old_path: diff?.renamed_file ? diff.old_path : finding.file,
      new_path: finding.file,
      new_line: pos?.newLine ?? finding.line,
    };
    // A context line must also carry old_line or GitLab rejects the position.
    if (pos?.oldLine !== undefined) position.old_line = pos.oldLine;
    const body = finding.body.trim();
    // No top-level note fallback: findings must land as resolvable inline
    // discussions. An unanchorable finding surfaces as an error instead.
    const created = await withRetry(
      () =>
        this.api<{ id: string }>(ref, `/merge_requests/${ref.number}/discussions`, {
          method: 'POST',
          body: { body, position },
        }),
      isTransientGitLabError,
      `${finding.file}:${finding.line}`,
    );
    return { id: String(created.id) };
  }
}
