import { execFileSync } from 'node:child_process';
import type { ChangedFile, ExistingComment, Finding, PrMetadata, PrRef } from '../types.js';
import type { PrProvider } from './types.js';
import { withRetry } from '../util/retry.js';
import { execErrorDetail } from '../util/exec-error.js';
import { safeDecode } from '../util/url.js';
import { diffLines } from '../util/diff-lines.js';

// Modern (/-/merge_requests/) and legacy (no /-/) forms, any host, nested
// namespaces (group/subgroup/project). Trailing /diffs, query, #note_x fall
// off after the iid digits.
const URL_RE = /^https?:\/\/[^\/]+\/(.+?)\/(?:-\/)?merge_requests\/(\d+)/i;

/**
 * Exported for tests; `exec` is the subprocess seam. Env tokens are only ever
 * sent to gitlab.com or a host the user explicitly named in the `hosts:`
 * allowlist — detectProvider refuses unknown hosts, so no crafted URL can
 * route this token elsewhere.
 */
export function resolveToken(host: string, exec: typeof execFileSync = execFileSync): string {
  const fromEnv = process.env.GITLAB_TOKEN ?? process.env.GITLAB_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;
  let detail: string;
  try {
    const token = exec('glab', ['config', 'get', 'token', '-h', host], {
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
  /** A STRING: numeric, `"N+"` once the stored diff overflowed (files, lines or bytes), empty while a new MR's diff is still computing. */
  changes_count?: string | null;
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
  // diffLines strips only the pre-content file headers — a `+++…` line inside
  // a hunk is real added content (text beginning `++`) and must be counted.
  for (const ln of diffLines(d.diff ?? '')) {
    if (ln.startsWith('@@')) continue;
    if (ln.startsWith('+')) additions++;
    else if (ln.startsWith('-')) deletions++;
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
  // diffLines strips only the pre-content file headers — an added line whose
  // text begins `++` (yielded as `+++…`) advances the NEW cursor like any `+`.
  for (const ln of diffLines(patch)) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (m) {
      oldLine = parseInt(m[1]!, 10) - 1;
      newLine = parseInt(m[2]!, 10) - 1;
      continue;
    }
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

/** The discussion position GitLab accepts. Required fields are compiler-checked — a missing SHA or path here IS the 400 "position is invalid". */
export interface DiscussionPosition {
  position_type: 'text';
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  new_line: number;
  old_line?: number;
}

/**
 * Build the position for an inline discussion, or throw a descriptive error —
 * GitLab's own rejection is an opaque 400, so anchoring problems must be named
 * locally. Pure; exported for tests (this assembly is the highest-risk logic
 * in the provider). `diff` undefined = file not in the MR diffs; a diff with
 * an empty patch (collapsed/oversized) posts new_line-only and lets the API
 * answer, since there is nothing to compute a position from.
 */
export function buildDiscussionPosition(
  diff: GitLabDiff | undefined,
  finding: { file: string; line: number },
  diffRefs: { base_sha: string; head_sha: string; start_sha: string },
): DiscussionPosition {
  if (!diff) {
    throw new Error(`cannot anchor ${finding.file}:${finding.line} — ${finding.file} is not in the MR diffs`);
  }
  const pos = diff.diff ? positionForLine(diff.diff, finding.line) : null;
  if (diff.diff && !pos) {
    throw new Error(
      `cannot anchor ${finding.file}:${finding.line} — line ${finding.line} is not in the MR diff for that file`,
    );
  }
  const position: DiscussionPosition = {
    position_type: 'text',
    base_sha: diffRefs.base_sha,
    start_sha: diffRefs.start_sha,
    head_sha: diffRefs.head_sha,
    // old_path is required even for new-side comments; on a rename it must
    // be the real old path or the API 400s.
    old_path: diff.renamed_file ? diff.old_path : finding.file,
    new_path: finding.file,
    new_line: pos?.newLine ?? finding.line,
  };
  // A context line must also carry old_line or GitLab rejects the position.
  if (pos?.oldLine !== undefined) position.old_line = pos.oldLine;
  return position;
}

/** Exported for tests: the branch-y MR → PrMetadata mapping (state collapse, draft alias, SHA fallbacks). */
export function mapMrMetadata(mr: GitLabMr, linkedItems: PrMetadata['linkedItems']): PrMetadata {
  // "N+" is the overflow flag, not a floor: /diffs pages over the STORED diff,
  // which is exactly the capped set, so the list has exactly N entries.
  const count = /^(\d+)(\+)?$/.exec(mr.changes_count ?? '');
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
    ...(count ? { changedFileCount: Number(count[1]), changedFileListTruncated: count[2] === '+' } : {}),
  };
}

/** Exported for tests: note → ExistingComment mapping (position fallbacks feed dedupe). */
export function mapNote(n: GitLabNote): ExistingComment {
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
}

export class GitLabProvider implements PrProvider {
  readonly name = 'gitlab' as const;
  /** One MR/diffs fetch per (host, project, iid) for the instance's lifetime — posting N findings must not re-fetch N times. */
  private mrCache: Map<string, Promise<GitLabMr>> = new Map();
  private diffsCache: Map<string, Promise<GitLabDiff[]>> = new Map();
  /** Token per host — the glab CLI fallback is a blocking subprocess and must not run once per request. */
  private tokenByHost: Map<string, string> = new Map();

  authEnv(ref: PrRef): Record<string, string> {
    return { GITLAB_TOKEN: this.token(new URL(ref.url).host) };
  }

  private token(host: string): string {
    let t = this.tokenByHost.get(host);
    if (!t) {
      t = resolveToken(host);
      this.tokenByHost.set(host, t);
    }
    return t;
  }

  parseUrl(url: string): PrRef | null {
    const m = url.match(URL_RE);
    if (!m) return null;
    const parts = m[1]!.split('/').filter(Boolean).map(safeDecode);
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
    const token = this.token(new URL(ref.url).host);
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
      const items = (await res.json()) as T[];
      out.push(...items);
      page = res.headers.get('x-next-page') ?? '';
      // A full page with no next-page header smells like a proxy stripping
      // pagination headers or an endpoint changing pagination modes — say so
      // instead of silently truncating the review to the first 100 items.
      if (!page && items.length === 100) {
        process.stderr.write(
          `[gitlab] ${path}: got a full page with no x-next-page header — results may be truncated at ${out.length}\n`,
        );
      }
    }
    return out;
  }

  private cacheKey(ref: PrRef): string {
    return `${new URL(ref.url).origin}#${ref.owner}/${ref.repo}#${ref.number}`;
  }

  /**
   * Both caches memoize the request PROMISE and evict on rejection —
   * otherwise one transient 5xx would stay cached and fail every later
   * caller with the same stale error. The fetch itself retries: these GETs
   * back every provider method, including the per-finding posting loop.
   */
  private getMr(ref: PrRef): Promise<GitLabMr> {
    const key = this.cacheKey(ref);
    let mr = this.mrCache.get(key);
    if (!mr) {
      mr = withRetry(
        () => this.api<GitLabMr>(ref, `/merge_requests/${ref.number}`),
        isTransientGitLabError,
        `MR !${ref.number}`,
      ).catch((err) => {
        this.mrCache.delete(key);
        throw err;
      });
      this.mrCache.set(key, mr);
    }
    return mr;
  }

  private getDiffs(ref: PrRef): Promise<GitLabDiff[]> {
    const key = this.cacheKey(ref);
    let diffs = this.diffsCache.get(key);
    if (!diffs) {
      diffs = withRetry(
        () => this.apiAll<GitLabDiff>(ref, `/merge_requests/${ref.number}/diffs`),
        isTransientGitLabError,
        `MR !${ref.number} diffs`,
      ).catch((err) => {
        this.diffsCache.delete(key);
        throw err;
      });
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
    return mapMrMetadata(mr, linkedItems);
  }

  async fetchChangedFiles(ref: PrRef): Promise<ChangedFile[]> {
    return (await this.getDiffs(ref)).map(mapDiff);
  }

  async fetchFullDiff(ref: PrRef): Promise<string> {
    return buildFullDiff(await this.getDiffs(ref));
  }

  async fetchExistingComments(ref: PrRef): Promise<ExistingComment[]> {
    const notes = await this.apiAll<GitLabNote>(ref, `/merge_requests/${ref.number}/notes`);
    return notes.filter((n) => !n.system).map(mapNote);
  }

  isTransientError(err: Error): boolean {
    return isTransientGitLabError(err);
  }

  /**
   * ONE attempt: creating a discussion is not idempotent, so a 5xx or timeout
   * arriving after GitLab committed it must not be re-issued here. runPost
   * retries only once the MR confirms the discussion is genuinely absent.
   */
  async postLineComment(ref: PrRef, finding: Finding, _headSha?: string): Promise<{ id: string } | null> {
    if (!finding.file || !finding.line) return null;
    // Position SHAs must match the MR's recorded diff version, so the gather
    // headSha param is deliberately ignored — a stale value 400s the post.
    const mr = await this.getMr(ref);
    if (!mr.diff_refs) {
      throw new Error(`MR !${ref.number} has no diff_refs — cannot anchor an inline discussion`);
    }
    const diff = (await this.getDiffs(ref)).find((d) => d.new_path === finding.file);
    const position = buildDiscussionPosition(diff, { file: finding.file, line: finding.line }, mr.diff_refs);
    const body = finding.body.trim();
    // No top-level note fallback: findings must land as resolvable inline
    // discussions. An unanchorable finding surfaces as an error instead.
    const created = await this.api<{ id: string }>(ref, `/merge_requests/${ref.number}/discussions`, {
      method: 'POST',
      body: { body, position },
    });
    return { id: String(created.id) };
  }
}
