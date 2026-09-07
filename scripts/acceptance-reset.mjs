// Token resolution and comment teardown for the acceptance fixture PRs.
//
// Deliberately plain `fetch` rather than the product's PrProvider: deleting
// comments is a test-only verb, and the production interface must not grow one.
// The URL parsers here are minimal on purpose — they only ever see the fixture
// URLs in evals/acceptance/matrix.yaml.
//
// Token precedence mirrors the providers' own (src/providers/*.ts) so one code
// path serves CI (env vars set) and local runs (CLI fallback). The one
// deliberate difference: COPILOT_GITHUB_TOKEN is NOT consulted for GitHub. In
// Actions that variable holds the Copilot CLI's token, which has no access to
// the fixture repo, and silently reaching for it would produce a 404 that looks
// like a missing PR.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_API = 'https://api.github.com';

/**
 * Optional credential files, `KEY=value` per line, `#` for comments.
 *
 * `.env` at the repo root is the conventional place and is read first;
 * `~/.pr-review/acceptance.env` also works for anyone who would rather keep
 * credentials outside the checkout entirely.
 *
 * `.env` is gitignored, `.env.example` is what ships, and the dogfood gate
 * already refuses any untracked path matching /^\.env/ before it writes an
 * artifact — three independent guards, because a file inside the repository
 * is the one arrangement where a stray `git add -A` could publish a token.
 *
 * Lowest precedence but one: a real environment variable always wins, which
 * is what keeps CI — where these arrive as environment secrets and no file
 * exists — running on exactly the same code path.
 */
const CREDENTIAL_FILES = [
  join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  join(homedir(), '.pr-review', 'acceptance.env'),
];

let fileEnvCache = null;
function fileEnv() {
  if (fileEnvCache) return fileEnvCache;
  fileEnvCache = {};
  // Reverse order, so the repo-root file wins over the home one.
  for (const path of [...CREDENTIAL_FILES].reverse()) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      // Strip one layer of surrounding quotes so a pasted value with spaces works.
      const quoted = /^(['"])(.*)\1$/.exec(line.slice(eq + 1).trim());
      const value = quoted ? quoted[2] : line.slice(eq + 1).trim();
      if (value) fileEnvCache[line.slice(0, eq).trim()] = value;
    }
  }
  return fileEnvCache;
}
/** `process.env` first, then the local file. Never logs the value. */
/**
 * The credential files' values, for handing to a child process.
 *
 * The product's own providers read `process.env` and must never learn about a
 * test credential file — so the harness injects, rather than the CLI reading.
 * Environment variables still win: the caller spreads `process.env` last.
 */
export function credentialEnv() {
  return { ...fileEnv() };
}

/** `process.env` first, then the credential files. Never logs the value. */
function credential(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  const fromFile = fileEnv();
  for (const name of names) {
    if (fromFile[name]) return fromFile[name];
  }
  return undefined;
}

function cli(file, args) {
  try {
    const out = execFileSync(file, args, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** @returns {{scheme: 'bearer'|'basic'|'token', value: string}} */
export function resolveToken(provider, host) {
  if (provider === 'github') {
    const token = credential('GITHUB_TOKEN', 'GH_TOKEN') ?? cli('gh', ['auth', 'token']);
    if (!token) throw new Error('no GitHub token: set GITHUB_TOKEN, add it to .env, or run `gh auth login`');
    return { scheme: 'bearer', value: token };
  }
  if (provider === 'gitlab') {
    const token = credential('GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN') ?? cli('glab', ['config', 'get', 'token', '-h', host ?? 'gitlab.com']);
    if (!token) throw new Error('no GitLab token: set GITLAB_TOKEN (scope `api`) in the environment or .env, or run `glab auth login`');
    return { scheme: 'bearer', value: token };
  }
  if (provider === 'azuredevops') {
    const pat = credential('AZURE_DEVOPS_PAT', 'SYSTEM_ACCESSTOKEN', 'AZURE_DEVOPS_EXT_PAT');
    if (pat) return { scheme: 'basic', value: Buffer.from(`:${pat}`).toString('base64') };
    const bearer =
      credential('AZURE_DEVOPS_BEARER') ??
      cli('az', ['account', 'get-access-token', '--resource', '499b84ac-1321-427f-aa17-267ca6975798', '--query', 'accessToken', '-o', 'tsv']);
    if (!bearer) {
      throw new Error('no Azure DevOps credential: set AZURE_DEVOPS_PAT (Code read+write, PR Threads read+write) in the environment or .env, or run `az login`');
    }
    return { scheme: 'bearer', value: bearer };
  }
  throw new Error(`unknown provider: ${provider}`);
}

/**
 * A git URL with the credential inlined, for cloning and pushing.
 *
 * Built by string rather than through the URL object's userinfo setters:
 * those read as a hardcoded credential to any secret scanner worth having,
 * including this repo's own dogfood gate, and a scanner that has to be taught
 * exceptions stops being one. The returned `secret` is what `mask()` strips
 * from every git error before it is printed.
 *
 * This is why `matrix.yaml` can hold a plain, credential-free clone URL: the
 * credential is added at the moment of use and never stored. A fixture
 * repository therefore does not have to be public — that was a constraint of
 * the first cut, not of the design.
 */
export function credentialedGitUrl(provider, clone, token) {
  const u = new URL(clone);
  const user = provider === 'github' ? 'x-access-token' : provider === 'gitlab' ? 'oauth2' : 'pr-review';
  const secret = token.scheme === 'basic' ? Buffer.from(token.value, 'base64').toString('utf8').replace(/^:/, '') : token.value;
  const userinfo = `${encodeURIComponent(user)}:${encodeURIComponent(secret)}`;
  return { url: `${u.protocol}//${userinfo}@${u.host}${u.pathname}${u.search}`, secret };
}
function authHeader(token) {
  return token.scheme === 'basic' ? `Basic ${token.value}` : `Bearer ${token.value}`;
}

/** Parse one of the three fixture PR URL shapes into the fields the REST calls need. */
export function parsePrUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  const parts = u.pathname.split('/').filter(Boolean);

  const ado = parts.indexOf('_git');
  if (ado !== -1) {
    // dev.azure.com/<org>[/<project>]/_git/<repo>/pullrequest/<id>
    const lead = parts.slice(0, ado);
    const org = lead[0];
    const project = lead[1] ?? lead[0];
    const repo = parts[ado + 1];
    const number = Number(parts[ado + 3]);
    if (!org || !repo || !Number.isInteger(number)) throw new Error(`unrecognised Azure DevOps PR URL: ${url}`);
    return { provider: 'azuredevops', host: u.host, origin: u.origin, org, project, repo, number };
  }

  const mr = parts.indexOf('merge_requests');
  if (mr !== -1) {
    // <host>/<namespace...>/[-/]merge_requests/<iid>
    const lead = parts.slice(0, mr).filter((p) => p !== '-');
    const number = Number(parts[mr + 1]);
    if (lead.length < 2 || !Number.isInteger(number)) throw new Error(`unrecognised GitLab MR URL: ${url}`);
    return { provider: 'gitlab', host: u.host, origin: u.origin, project: lead.join('/'), number };
  }

  const pull = parts.indexOf('pull');
  if (pull === 2) {
    const number = Number(parts[3]);
    if (!Number.isInteger(number)) throw new Error(`unrecognised GitHub PR URL: ${url}`);
    return { provider: 'github', host: u.host, origin: u.origin, owner: parts[0], repo: parts[1], number };
  }

  throw new Error(`unrecognised PR URL: ${url}`);
}

async function api(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: authHeader(token),
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'pr-review-acceptance',
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
  }
  return res;
}

async function githubPaged(url, token) {
  const out = [];
  let next = url;
  while (next) {
    const res = await api(next, token);
    out.push(...(await res.json()));
    const link = res.headers.get('link') ?? '';
    const match = /<([^>]+)>;\s*rel="next"/.exec(link);
    next = match ? match[1] : null;
  }
  return out;
}

/**
 * Every comment on the fixture PR that a run could have written, normalised to
 * `{ id, kind, body, author, inline }`.
 *
 * System/service notes are excluded: GitLab's are undeletable, and Azure DevOps
 * emits them for every push.
 */
export async function listComments(pr, token) {
  if (pr.provider === 'github') {
    const base = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}`;
    const [inline, issue] = await Promise.all([
      githubPaged(`${base}/pulls/${pr.number}/comments?per_page=100`, token),
      githubPaged(`${base}/issues/${pr.number}/comments?per_page=100`, token),
    ]);
    return [
      ...inline.map((c) => ({ id: c.id, kind: 'review', body: c.body ?? '', author: c.user?.login ?? '?', inline: true })),
      ...issue.map((c) => ({ id: c.id, kind: 'issue', body: c.body ?? '', author: c.user?.login ?? '?', inline: false })),
    ];
  }
  if (pr.provider === 'gitlab') {
    const project = encodeURIComponent(pr.project);
    const out = [];
    for (let page = 1; ; page++) {
      const res = await api(`${pr.origin}/api/v4/projects/${project}/merge_requests/${pr.number}/notes?per_page=100&page=${page}`, token);
      const batch = await res.json();
      out.push(...batch);
      const next = res.headers.get('x-next-page');
      if (!next) break;
    }
    return out
      .filter((n) => n.system !== true)
      .map((n) => ({ id: n.id, kind: 'note', body: n.body ?? '', author: n.author?.username ?? '?', inline: Boolean(n.position) }));
  }
  // Azure DevOps: threads, each with comments. Deleted comments linger as
  // tombstones (isDeleted, empty content) — harmless for dedupe, since the
  // Jaccard of an empty token set against anything is 0, but they must not be
  // counted as "still dirty" after a reset.
  const url = `${pr.origin}/${pr.org}/${pr.project}/_apis/git/repositories/${pr.repo}/pullRequests/${pr.number}/threads?api-version=7.1`;
  const res = await api(url, token);
  const { value = [] } = await res.json();
  return value.flatMap((thread) =>
    (thread.comments ?? [])
      .filter((c) => c.isDeleted !== true && (c.content ?? '').trim() !== '' && c.commentType !== 'system')
      .map((c) => ({
        id: `${thread.id}/${c.id}`,
        kind: 'thread',
        body: c.content ?? '',
        author: c.author?.displayName ?? '?',
        inline: Boolean(thread.threadContext?.filePath),
      })),
  );
}

export async function deleteComment(pr, token, comment) {
  if (pr.provider === 'github') {
    const base = `${GITHUB_API}/repos/${pr.owner}/${pr.repo}`;
    const path = comment.kind === 'review' ? `pulls/comments/${comment.id}` : `issues/comments/${comment.id}`;
    await api(`${base}/${path}`, token, { method: 'DELETE' });
    return;
  }
  if (pr.provider === 'gitlab') {
    const project = encodeURIComponent(pr.project);
    await api(`${pr.origin}/api/v4/projects/${project}/merge_requests/${pr.number}/notes/${comment.id}`, token, { method: 'DELETE' });
    return;
  }
  const [threadId, commentId] = String(comment.id).split('/');
  const url = `${pr.origin}/${pr.org}/${pr.project}/_apis/git/repositories/${pr.repo}/pullRequests/${pr.number}/threads/${threadId}/comments/${commentId}?api-version=7.1`;
  await api(url, token, { method: 'DELETE' });
}

/**
 * Clean the fixture PR, then PROVE it is clean.
 *
 * Reset runs before a cell, never after — an after-reset is exactly the step a
 * cancelled run skips, which is how a fixture PR stays dirty for the next run.
 * The re-read is the load-bearing half: a leftover comment silently drops
 * `must_find` findings through dedupeAgainstExisting (±3 lines + Jaccard), and
 * you would spend the afternoon debugging the model instead of the harness.
 */
export async function resetPr(url, { log = () => {} } = {}) {
  const pr = parsePrUrl(url);
  const token = resolveToken(pr.provider, pr.host);
  const before = await listComments(pr, token);
  for (const comment of before) {
    await deleteComment(pr, token, comment);
  }
  const after = await listComments(pr, token);
  if (after.length > 0) {
    throw new Error(
      `${url}: ${after.length} comment(s) survived the reset (${after.slice(0, 3).map((c) => `${c.kind}:${c.id} by ${c.author}`).join(', ')}) — ` +
        'refusing to review against a poisoned baseline, which would silently dedupe expected findings away',
    );
  }
  log(`reset ${url}: deleted ${before.length} comment(s), 0 remain`);
  return { deleted: before.length };
}
