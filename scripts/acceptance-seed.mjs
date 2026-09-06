// Create (or refresh) the acceptance estate: push the fixture content to the
// three repos, create one defect branch per runtime, and open the pull requests.
//
// Idempotent by construction: branches are force-pushed from the committed
// source of truth in evals/acceptance/, and an existing open PR for a branch is
// reused rather than duplicated. Re-run it whenever the fixture content changes
// or a PR is closed by accident.
//
// You create the three empty repos by hand (see evals/acceptance/README.md);
// everything after that is this script.
//
// Usage:
//   node scripts/acceptance-seed.mjs [--provider github,azuredevops,gitlab] [--dry-run]

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveToken } from './acceptance-reset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE = join(ROOT, 'evals', 'acceptance');
const MATRIX = join(ACCEPTANCE, 'matrix.yaml');
const PROVIDERS = ['github', 'azuredevops', 'gitlab'];
const WIDE_FILES = 101; // GitLab reports changes_count "100+" above 100

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const only = (() => {
  const i = argv.indexOf('--provider');
  if (i === -1) return PROVIDERS;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error('--provider needs a value, e.g. --provider gitlab');
    process.exit(2);
  }
  return value.split(',').map((s) => s.trim()).filter(Boolean);
})();

/**
 * Never let a token reach stdout, stderr, or an exception message.
 *
 * Masks the percent-encoded form as well as the raw one: the push URL carries
 * the credential encoded, so masking only the raw token would leave the exact
 * string an error message actually prints.
 */
function mask(text, ...secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join('***');
    }
  }
  return out;
}

function git(args, cwd, secrets = []) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    throw new Error(mask(`git ${args[0]} failed: ${err.stderr || err.message}`, ...secrets));
  }
}

/**
 * Copy a fixture tree, stripping the leading `_` from manifest filenames.
 *
 * The fixture needs a real `package.json` and `requirements.txt` — that is how
 * it proves dependency detection. But committing them under those names makes
 * them THIS repository's manifests: `findChangedFileManifests` matches on
 * basename regardless of directory, so every review of pr-review itself would
 * detect express, pg, flask and django and route passes for a stack it does not
 * have. Observed on this branch's own dogfood run. The underscore is invisible
 * to the manifest regexes and is removed here, where the fixture is built.
 */
function copyTree(from, to) {
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dest = join(to, entry.startsWith('_') ? entry.slice(1) : entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyTree(src, dest);
    } else {
      cpSync(src, dest);
    }
  }
}

/**
 * Remote URL with the credential inlined — the one push path that works in CI
 * and locally alike.
 *
 * Built by string rather than through the URL object's userinfo setters: those
 * setters read as a hardcoded credential to any secret scanner worth having,
 * including this repo's own dogfood gate, and a scanner that has to be taught
 * exceptions stops being one. The returned secret is what `mask()` strips from
 * every git error before it is printed.
 */
function pushUrl(provider, clone, token) {
  const u = new URL(clone);
  const user = provider === 'github' ? 'x-access-token' : provider === 'gitlab' ? 'oauth2' : 'pr-review';
  const secret = token.scheme === 'basic' ? Buffer.from(token.value, 'base64').toString('utf8').replace(/^:/, '') : token.value;
  const userinfo = `${encodeURIComponent(user)}:${encodeURIComponent(secret)}`;
  return { url: `${u.protocol}//${userinfo}@${u.host}${u.pathname}${u.search}`, secret };
}

async function api(url, token, init = {}) {
  const auth = token.scheme === 'basic' ? `Basic ${token.value}` : `Bearer ${token.value}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: auth,
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'pr-review-acceptance',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${res.statusText} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/** Open the PR for `branch`, or return the one already open. */
async function ensurePr(provider, cfg, token, branch, title) {
  if (provider === 'github') {
    const [, owner, repo] = new URL(cfg.web).pathname.split('/');
    const base = `https://api.github.com/repos/${owner}/${repo}`;
    const open = await api(`${base}/pulls?head=${owner}:${branch}&state=open`, token);
    if (open.length > 0) return open[0].html_url;
    const created = await api(`${base}/pulls`, token, {
      method: 'POST',
      body: JSON.stringify({ title, head: branch, base: 'main', body: 'Acceptance fixture. Opened by scripts/acceptance-seed.mjs.' }),
    });
    return created.html_url;
  }
  if (provider === 'gitlab') {
    const u = new URL(cfg.web);
    const project = encodeURIComponent(u.pathname.replace(/^\//, '').replace(/\.git$/, ''));
    const base = `${u.origin}/api/v4/projects/${project}`;
    const open = await api(`${base}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`, token);
    if (open.length > 0) return open[0].web_url;
    const created = await api(`${base}/merge_requests`, token, {
      method: 'POST',
      body: JSON.stringify({ source_branch: branch, target_branch: 'main', title, description: 'Acceptance fixture. Opened by scripts/acceptance-seed.mjs.' }),
    });
    return created.web_url;
  }
  const u = new URL(cfg.web);
  const parts = u.pathname.split('/').filter(Boolean);
  const gitIdx = parts.indexOf('_git');
  const org = parts[0];
  const project = parts[gitIdx - 1];
  const repo = parts[gitIdx + 1];
  const base = `${u.origin}/${org}/${project}/_apis/git/repositories/${repo}/pullrequests`;
  const open = await api(
    `${base}?searchCriteria.sourceRefName=refs/heads/${branch}&searchCriteria.status=active&api-version=7.1`,
    token,
  );
  if ((open.value ?? []).length > 0) {
    return `${u.origin}/${org}/${project}/_git/${repo}/pullrequest/${open.value[0].pullRequestId}`;
  }
  const created = await api(`${base}?api-version=7.1`, token, {
    method: 'POST',
    body: JSON.stringify({
      sourceRefName: `refs/heads/${branch}`,
      targetRefName: 'refs/heads/main',
      title,
      description: 'Acceptance fixture. Opened by scripts/acceptance-seed.mjs.',
    }),
  });
  return `${u.origin}/${org}/${project}/_git/${repo}/pullrequest/${created.pullRequestId}`;
}

function commitTree(work, message, secrets) {
  git(['add', '-A'], work, secrets);
  // A tree identical to HEAD is the normal idempotent case, not a failure.
  const staged = git(['diff', '--cached', '--name-only'], work, secrets).trim();
  if (staged === '') return false;
  git(['-c', 'user.name=pr-review acceptance', '-c', 'user.email=acceptance@pr-review.invalid', 'commit', '-q', '-m', message], work, secrets);
  return true;
}

async function seedProvider(provider, matrix) {
  const cfg = matrix.providers[provider];
  if (!cfg || String(cfg.clone).includes('CHANGE-ME')) {
    console.log(`  ${provider}: matrix.yaml still has the CHANGE-ME placeholder — skipping`);
    return null;
  }
  const token = resolveToken(provider, new URL(cfg.clone).host);
  const { url: remote, secret } = pushUrl(provider, cfg.clone, token);
  const secrets = [secret, token.value];
  const work = mkdtempSync(join(tmpdir(), `acc-seed-${provider}-`));

  try {
    git(['init', '-q', '-b', 'main'], work, secrets);
    // The credentialed URL is passed to each push, never stored as a remote:
    // `git remote add` writes it into .git/config, so the PAT would sit in
    // plaintext on disk for the life of the working copy.
    const push = (...refs) => git(['push', '--force', remote, ...refs], work, secrets);

    // main: the base tree.
    copyTree(join(ACCEPTANCE, 'repo'), work);
    commitTree(work, 'chore: acceptance fixture base', secrets);
    if (!dryRun) push('main');

    const urls = {};
    for (const [runtime, branch] of Object.entries(matrix.branches)) {
      if (runtime === 'wide') continue;
      git(['checkout', '-q', '-B', branch, 'main'], work, secrets);
      copyTree(join(ACCEPTANCE, 'defects'), work);
      commitTree(work, 'feat: add user lookup and the nightly report job', secrets);
      if (!dryRun) {
        push(branch);
        urls[runtime] = await ensurePr(provider, cfg, token, branch, `Acceptance: user lookup + nightly report (${runtime})`);
        console.log(`  ${provider}/${runtime}: ${urls[runtime]}`);
      }
      git(['checkout', '-q', 'main'], work, secrets);
    }

    // GitLab only: the wide MR that trips the truncated-file-list gate. GitLab
    // is the sole provider that declares truncation (changes_count "100+");
    // GitHub needs 3000+ files and Azure DevOps reports no count at all, so
    // forcing this case there would prove nothing.
    let wide = null;
    if (provider === 'gitlab') {
      const branch = matrix.branches.wide;
      git(['checkout', '-q', '-B', branch, 'main'], work, secrets);
      mkdirSync(join(work, 'wide'), { recursive: true });
      for (let i = 0; i < WIDE_FILES; i++) {
        writeFileSync(join(work, 'wide', `f${String(i).padStart(3, '0')}.txt`), `line ${i}\n`, 'utf8');
      }
      commitTree(work, `chore: ${WIDE_FILES} files to exceed the diff cap`, secrets);
      if (!dryRun) {
        push(branch);
        wide = await ensurePr(provider, cfg, token, branch, `Acceptance: ${WIDE_FILES}-file change (file-list gate)`);
        console.log(`  ${provider}/wide: ${wide}`);
      }
      git(['checkout', '-q', 'main'], work, secrets);
    }

    return { urls, wide };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const matrix = parseYaml(readFileSync(MATRIX, 'utf8'));
let text = readFileSync(MATRIX, 'utf8');
let failures = 0;

for (const provider of only) {
  if (!PROVIDERS.includes(provider)) {
    console.error(`unknown provider: ${provider}`);
    process.exit(2);
  }
  console.log(`\n=== ${provider} ===`);
  try {
    const result = await seedProvider(provider, matrix);
    if (!result || dryRun) continue;
    // Write the PR URLs back so the runner and the workflow need no arguments.
    for (const [runtime, url] of Object.entries(result.urls)) {
      matrix.providers[provider].pulls[runtime] = url;
    }
    if (result.wide) matrix.providers[provider].wide = result.wide;
  } catch (err) {
    failures++;
    console.error(`✗ ${provider}: ${err.message}`);
  }
}

if (!dryRun && failures === 0) {
  // Surgical rewrite: keep every comment in matrix.yaml and replace only the
  // values the seeder owns. A full YAML re-serialise would drop the comments
  // that explain what each field is for.
  //
  // Line-walked rather than regex-replaced because the keys repeat under every
  // provider: a non-global replace would overwrite the previous provider's URL
  // on the next iteration.
  let current = null;
  const out = text.split('\n').map((line) => {
    const provider = /^ {2}(\w+):\s*$/.exec(line);
    if (provider && PROVIDERS.includes(provider[1])) {
      current = provider[1];
      return line;
    }
    if (!current) return line;
    const runtime = /^( {6}(claude|copilot):\s*)(.*)$/.exec(line);
    if (runtime) {
      const url = matrix.providers[current]?.pulls?.[runtime[2]];
      return url ? `${runtime[1]}${url}` : line;
    }
    const wide = /^( {4}wide:\s*)(.*)$/.exec(line);
    if (wide) {
      const url = matrix.providers[current]?.wide;
      return url ? `${wide[1]}${url}` : line;
    }
    return line;
  });
  writeFileSync(MATRIX, out.join('\n'), 'utf8');
  console.log(`\nwrote PR URLs back to ${MATRIX}`);
}

console.log(failures === 0 ? '\nestate ready' : `\n${failures} provider(s) failed`);
process.exit(failures === 0 ? 0 : 1);
