// The acceptance matrix: 3 providers x 2 runtimes against REAL pull requests,
// posting for real.
//
// This is the only thing in the repo that proves Azure DevOps and GitLab work
// at all — every provider test is stubbed — and the only thing that runs the
// Copilot runtime end to end. What it asserts is not "the review found bugs"
// but "the run honoured the contract": inline threads landed, nothing top-level
// appeared, the file list was complete, the stack and the repo's own skill
// reached the session, and every planned pass delivered.
//
// Usage:
//   node scripts/acceptance.mjs [--provider github,azuredevops,gitlab]
//                               [--runtime claude,copilot]
//                               [--case defects,filelist]
//                               [--checkout <dir>] [--out <dir>]
//                               [--dry-run] [--reset-only]
//
// Needs: `npm run build`, the agent CLI for each runtime on PATH, provider
// credentials (env vars, or the gh/az/glab logins the providers fall back to),
// and `pr-review packs sync` done at least once.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { matchExpectedFindings, safeLogValue, stackExpectationFailures } from './eval-assertions.mjs';
import { credentialEnv, credentialedGitUrl, listComments, parsePrUrl, resetPr, resolveToken } from './acceptance-reset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE = join(ROOT, 'evals', 'acceptance');
const CLI = join(ROOT, 'dist', 'cli.cjs');
const RUNS_ROOT = join(homedir(), '.pr-review', 'runs');
const PROVIDERS = ['github', 'azuredevops', 'gitlab'];
const RUNTIMES = ['claude', 'copilot'];
const CELL_TIMEOUT_MS = 30 * 60 * 1000;

/** `--name value`, or null. A flag with no value is an error, not an empty string. */
function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} needs a value`);
    process.exit(2);
  }
  return value;
}
const has = (name) => process.argv.includes(`--${name}`);
const list = (name, fallback) => (flag(name) ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);

const wantProviders = list('provider', PROVIDERS.join(','));
const wantRuntimes = list('runtime', RUNTIMES.join(','));
const wantCases = list('case', 'defects,filelist');
const dryRun = has('dry-run');
const resetOnly = has('reset-only');
// Lazily: naming --out must not still mint an empty temp directory.
const outDir = flag('out') ?? mkdtempSync(join(tmpdir(), 'pr-review-acceptance-'));
const checkoutRoot = flag('checkout');

const matrix = parseYaml(readFileSync(join(ACCEPTANCE, 'matrix.yaml'), 'utf8'));
const expected = parseYaml(readFileSync(join(ACCEPTANCE, 'expected.yaml'), 'utf8'));

if (!existsSync(CLI)) {
  console.error(`dist/cli.cjs is missing — run \`npm run build\` first (the matrix drives the real bundle, not src/)`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/**
 * Spawn a child with the harness's credentials available to it.
 *
 * `~/.pr-review/acceptance.env` is a harness convenience; the product reads
 * only `process.env`, so the values are injected here rather than taught to
 * the CLI. A real environment variable still wins — it is spread last.
 */
function run(file, args, opts = {}) {
  return execFileSync(file, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    timeout: CELL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...opts,
    // After the spread, not before: a caller passing its own `env` would
    // otherwise drop the file credentials on the floor.
    env: { ...credentialEnv(), ...process.env, ...(opts.env ?? {}) },
  });
}

/**
 * A full-depth clone of the fixture repo, one per provider.
 *
 * Full depth, and not `actions/checkout`: `detectStack` only reads the
 * checkout's manifests when its git origin canonically matches the PR
 * (`cwdIsPrRepo`), and the same gate governs whether the repo's own
 * `.claude/skills` count as project rules. Run a cell from anywhere else and
 * the two strongest assertions in expected.yaml — the express/pg dependencies
 * and the ACC-LOG-002 rule id — fail for a reason that has nothing to do with
 * the tool. A shallow clone additionally breaks merge-base and the file-list
 * gate.
 */
const checkouts = new Map();
function checkoutFor(provider) {
  if (checkouts.has(provider)) return checkouts.get(provider);
  const clone = matrix.providers[provider]?.clone;
  if (!clone || String(clone).includes('CHANGE-ME')) {
    throw new Error(`evals/acceptance/matrix.yaml has no clone URL for ${provider} — run scripts/acceptance-seed.mjs`);
  }
  const dir = checkoutRoot ? join(checkoutRoot, provider) : mkdtempSync(join(tmpdir(), `acc-${provider}-`));
  if (existsSync(join(dir, '.git'))) {
    // A reused --checkout is stale by construction: the seeder force-pushes the
    // fixture branches, so a clone from a previous run would review last week's
    // content while asserting against today's expected.yaml.
    execFileSync('git', ['fetch', '--force', 'origin'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
    execFileSync('git', ['reset', '--hard', 'origin/main'], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  } else {
    mkdirSync(dir, { recursive: true });
    // Cloned with a credential resolved at runtime, so the fixture repository
    // does not have to be public and no token is stored in matrix.yaml. git
    // writes the URL into .git/config, so the remote is rewritten back to the
    // plain one immediately afterwards.
    const host = new URL(clone).host;
    const { url: authed, secret } = credentialedGitUrl(provider, clone, resolveToken(provider, host));
    try {
      execFileSync('git', ['clone', '--no-single-branch', authed, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      throw new Error(String(err.stderr || err.message).split(secret).join('***'));
    }
    execFileSync('git', ['remote', 'set-url', 'origin', clone], { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  }
  checkouts.set(provider, dir);
  return dir;
}

/**
 * Can this runtime actually do the work right now?
 *
 * A cell that cannot run is BLOCKED, never FAIL. Reporting a product defect
 * because an account is out of quota is the same lie `verify` refuses when it
 * insists a SKIP carry its reason — and the more expensive lie, because it
 * sends someone hunting a bug that does not exist. I made exactly that call
 * once in this repo's history and told the user the Copilot CLI "reports
 * success without executing what it dispatched"; the truth was zero premium
 * requests on the account.
 *
 * Observed: with `premium_interactions` exhausted the Copilot CLI rejects every
 * capable model and `auto` resolves to a small non-premium one, which ends a
 * 9-pass orchestration after two dispatches. INV-DEL-01 then correctly refuses
 * to post a partial review. Nothing in that chain is a pr-review failure.
 */
function runtimeBlockedReason(runtime) {
  if (runtime !== 'copilot') return null;
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!token) return null;
    const raw = execFileSync(
      'curl',
      ['-s', '-H', `Authorization: token ${token}`, '-H', 'Editor-Version: copilot-cli', 'https://api.github.com/copilot_internal/user'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const parsed = JSON.parse(raw);
    const quota = parsed?.quota_snapshots?.premium_interactions;
    if (!quota || quota.unlimited) return null;
    const remaining = Number(quota.remaining ?? quota.percent_remaining ?? 0);
    if (remaining > 0 || quota.overage_permitted) return null;
    const resets = parsed.quota_reset_date ?? 'the plan reset date';
    return `Copilot premium requests exhausted (0 remaining, overage not permitted). Every capable model is refused and \`auto\` falls back to a non-premium one that cannot carry a multi-pass orchestration. Resets ${resets}.`;
  } catch {
    // The probe is a courtesy, not a gate. If it cannot answer, run the cell and
    // let the real assertions speak.
    return null;
  }
}

/**
 * The newest run directory for a PR, by mtime.
 *
 * By mtime and not by name: the directory name ends in a timestamp, so sorting
 * lexically looks right until two providers' runs sit side by side and
 * `azuredevops__` outranks `gitlab__` regardless of when either ran.
 */
function latestRunDirFor(prUrl) {
  const { provider, number } = parsePrUrl(prUrl);
  let entries = [];
  try {
    entries = readdirSync(RUNS_ROOT);
  } catch {
    return null;
  }
  const mine = entries.filter((name) => name.startsWith(`${provider}__`) && name.includes(`__${number}__`)).map((name) => join(RUNS_ROOT, name));
  let newest = null;
  for (const dir of mine) {
    try {
      const at = statSync(dir).mtimeMs;
      if (!newest || at > newest.at) newest = { dir, at };
    } catch {
      // Vanished between readdir and stat; nothing to choose from it.
    }
  }
  return newest?.dir ?? null;
}

/**
 * Did the agent CLI refuse to work, rather than the review failing?
 *
 * Read from the run's own failure logs after the fact, because this class of
 * refusal is invisible until you spend the cell: a rate limit is not a counter
 * you can query, it is a 429 on the next request. Deliberately narrow — it
 * matches the vendor's own refusal wording, so a genuine pipeline failure that
 * merely mentions a limit somewhere cannot borrow the excuse.
 */
const RUNTIME_REFUSAL =
  /(?:hit|reached|exceeded) your rate limit|rate limit.{0,40}reset|quota (?:exceeded|exhausted)|premium (?:request|interaction)s?.{0,40}(?:exhaust|exceed|limit)|insufficient_quota|billing (?:hard )?limit|Model "[^"]+"[^\n]{0,80}is not available/i;

function runtimeRefusedToWork(prUrl) {
  const runDir = latestRunDirFor(prUrl);
  if (!runDir) return null;
  for (const name of ['orchestrator-failure.log', 'error.txt']) {
    const path = join(runDir, name);
    if (!existsSync(path)) continue;
    let text = '';
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const hit = text.match(RUNTIME_REFUSAL);
    if (!hit) continue;
    const line = text
      .split(/\r?\n/)
      .find((l) => RUNTIME_REFUSAL.test(l))
      ?.trim();
    return `the agent CLI refused to work, so nothing was reviewed: ${safeLogValue((line ?? hit[0]).slice(0, 200))}`;
  }
  return null;
}

/** The run `verify` resolved for this PR — the runner never guesses a run dir. */
function verifyRun(prUrl) {
  let raw = '';
  let exitCode = 0;
  try {
    raw = run(process.execPath, [CLI, 'verify', '--pr', prUrl, '--json']);
  } catch (err) {
    exitCode = err.status ?? 1;
    raw = err.stdout ?? '';
  }
  let report = null;
  try {
    report = JSON.parse(raw);
  } catch {
    // Left null; the cell reports the unparseable output below.
  }
  return { exitCode, report, raw };
}

function readArtifact(runDir, name) {
  const path = join(runDir, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function runDefectsCell(provider, runtime) {
  const prUrl = matrix.providers[provider]?.pulls?.[runtime];
  const failures = [];
  const blocked = runtimeBlockedReason(runtime);
  if (blocked) {
    return { provider, runtime, case: 'defects', ok: true, blocked, failures: [], prUrl };
  }
  if (!prUrl) {
    return { provider, runtime, case: 'defects', ok: false, failures: ['no PR URL in matrix.yaml — run scripts/acceptance-seed.mjs'] };
  }

  // Reset before the clone: --reset-only is the manual-recovery path and has no
  // business spending a full-depth clone to delete comments.
  await resetPr(prUrl, { log: (m) => console.log(`  ${m}`) });
  if (resetOnly) return { provider, runtime, case: 'defects', ok: true, failures: [], prUrl, resetOnly: true };
  const cwd = checkoutFor(provider);

  // --no-codex: the matrix proves providers x runtimes. Codex is an optional
  // sibling, and an enabled-but-failing one blocks completion — so a Codex
  // outage (a usage limit, say) would fail all six cells for a reason that has
  // nothing to do with what they test. Codex has its own coverage.
  const argv = [CLI, 'review', prUrl, '--no-cache', '--no-codex', '--runtime', runtime, ...(dryRun ? ['--dry-run'] : [])];
  let reviewExit = 0;
  try {
    run(process.execPath, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    reviewExit = err.status ?? 1;
    // A runtime that refused to work is BLOCKED, not FAIL — and the quota probe
    // above cannot see every way that happens. It reads the premium-request
    // counter, but a rate limit ("wait for your limit to reset in 5 hours")
    // only appears on use: the session exits in seconds, every pass reads as
    // failed to deliver, and INV-DEL-01 correctly refuses the partial review.
    // Every layer behaved; the account did not.
    const stalled = runtimeRefusedToWork(prUrl);
    if (stalled) return { provider, runtime, case: 'defects', ok: true, blocked: stalled, failures: [], prUrl };
    failures.push(`review exited ${reviewExit}`);
  }

  // verify locates the run for this PR and grades it against INVARIANTS.md.
  // Its rows are the contract half of the assertion set; everything below is
  // the fixture half — did this specific diff produce the expected review.
  const { exitCode: verifyExit, report, raw } = verifyRun(prUrl);
  if (!report) {
    failures.push(`pr-review verify produced no parseable JSON: ${safeLogValue(raw.slice(0, 300))}`);
    return { provider, runtime, case: 'defects', ok: false, failures, prUrl, reviewExit };
  }
  const runDir = join(RUNS_ROOT, report.runId);
  for (const row of report.rows.filter((r) => r.status === 'fail')) {
    failures.push(`${row.id}: ${safeLogValue(row.evidence)}`);
  }
  // Exit 1 means the audit could not be completed. Treating that as a pass is
  // the same "not checked reads as clean" mistake verify itself refuses.
  if (verifyExit === 1) failures.push('pr-review verify could not complete the audit (exit 1) — the run is unverified, not clean');

  const capabilities = readArtifact(runDir, 'capabilities.json');
  if (capabilities?.runtime !== runtime) {
    // The whole runtime axis rests on this: --runtime is an input, and only the
    // artifact can say which CLI actually hosted the session.
    failures.push(`capabilities.json records runtime '${capabilities?.runtime}', expected '${runtime}'`);
  }

  const stack = readArtifact(runDir, 'stack.json');
  if (stack?.cwdIsPrRepo !== true) {
    failures.push('stack.json says cwdIsPrRepo=false — the cell did not run inside a clone of the fixture repo');
  }
  failures.push(...stackExpectationFailures(expected, stack ?? {}));

  const findings = readArtifact(runDir, 'pr-review-findings.json')?.finalFindings ?? [];
  for (const { pattern, finding } of matchExpectedFindings(expected.must_find ?? [], findings, expected.distinct_findings === true)) {
    if (!finding) failures.push(`must_find unmatched: ${safeLogValue(pattern)}`);
  }
  for (const { pattern, finding } of matchExpectedFindings(expected.must_not_find ?? [], findings, false)) {
    if (finding) failures.push(`must_not_find matched: ${safeLogValue(pattern)} → ${safeLogValue(finding.title)}`);
  }

  const companions = readArtifact(runDir, 'companions.json');
  if (!companions) failures.push('companions.json is missing');
  else if (companions.detectionWarning) failures.push(`companion detection degraded: ${safeLogValue(companions.detectionWarning)}`);

  // Read-back: not "a comment exists" but "the review's content reached the PR".
  let posted = 0;
  if (!dryRun) {
    const marker = readArtifact(runDir, 'posted.marker');
    posted = marker?.posted ?? 0;
    const pr = parsePrUrl(prUrl);
    const live = await listComments(pr, resolveToken(pr.provider, pr.host));
    // Exact, not a lower bound. The cell reset the PR to zero comments before
    // the run, so anything other than `posted` is either a lost write or a
    // duplicate — and a lower bound passes the duplicate case, which is the
    // failure the whole posting discipline exists to prevent.
    if (live.length !== posted) {
      failures.push(`${posted} comment(s) reported posted but ${live.length} are on the PR (reset left it empty, so the counts must match)`);
    }
    const bodies = live.map((c) => c.body).join('\n---\n');
    const landed = (expected.must_find ?? []).some((p) => new RegExp(p, 'is').test(bodies));
    if (!landed) failures.push('no posted comment body matches any must_find pattern — findings were retained but not delivered');
    // INV-POST-01 re-anchors everything inline on GitHub and GitLab, so a
    // non-inline comment there is a violation. Azure DevOps legitimately posts
    // a location-less finding as a resolvable PR-level thread, so the same
    // check would false-fail — verify's own rows cover ADO instead.
    const nonInline = live.filter((c) => !c.inline);
    if (provider !== 'azuredevops' && nonInline.length > 0) {
      failures.push(`${nonInline.length} non-inline comment(s) on the PR after the run`);
    }
  }

  return {
    provider,
    runtime,
    case: 'defects',
    ok: failures.length === 0,
    failures,
    prUrl,
    runId: report.runId,
    runDir,
    reviewExit,
    verifyExit,
    posted,
    findings: findings.length,
  };
}

/**
 * The truncated-file-list gate, GitLab only and LLM-free.
 *
 * Both halves matter: from the fixture checkout the gate must complete the list
 * from git and succeed; from an unrelated directory it must REFUSE rather than
 * review an unknown file list. A positive-only assertion here would pass even
 * if the gate were deleted.
 */
/**
 * The MR's own file count, as GitLab reports it — the number `gather` has to
 * match to call its list complete.
 *
 * Returns `{ count }` when GitLab gives an exact number and `{ truncated }`
 * when it gives the `"N+"` form. The estate has never produced the second (it
 * reads "1200" for 1200 files), and the cell treats it as a signal that the
 * world changed rather than quietly passing: if GitLab starts truncating here,
 * the live refusal path becomes reachable and this cell should assert it.
 */
async function gitlabChangesCount(prUrl) {
  const { project, number, origin } = parsePrUrl(prUrl);
  const { value } = resolveToken('gitlab', new URL(prUrl).host);
  const res = await fetch(`${origin}/api/v4/projects/${encodeURIComponent(project)}/merge_requests/${number}`, {
    headers: { Authorization: `Bearer ${value}` },
  });
  if (!res.ok) throw new Error(`GitLab MR read failed: ${res.status}`);
  const raw = (await res.json()).changes_count;
  if (typeof raw === 'string' && raw.endsWith('+')) return { truncated: raw };
  const count = Number(raw);
  return Number.isInteger(count) ? { count } : {};
}

async function runFilelistCell() {
  const prUrl = matrix.providers.gitlab?.wide;
  const failures = [];
  if (!prUrl) return { provider: 'gitlab', runtime: '-', case: 'filelist', ok: false, failures: ['no wide MR URL in matrix.yaml'] };

  // What the wide MR proves live is PAGINATION, not truncation. GitLab serves
  // /diffs 100 entries per page, so a complete list here means the provider
  // walked every page — the exact bug that had Azure DevOps reviewing every
  // >100-file PR on its first 100 (`$top` default) from 0.6 through 0.10.
  //
  // It does NOT prove the refusal path, and no live provider can: the list has
  // to actually come back incomplete for a refusal to be correct. Measured on
  // this estate, GitLab's `changes_count` is exact at least through 1200 files
  // ("1200", not "1200+"), so the truncation flag never trips. The refusal is
  // covered hermetically by tests/gather.test.ts, which can stub a short list
  // against a high count. Naming that ceiling is the point — a live assertion
  // written for a truncation that never happens tests nothing, and the first
  // version of this cell asserted the *opposite* of correct behaviour: it
  // demanded a refusal on a list that was complete and therefore safe.
  const reported = await gitlabChangesCount(prUrl);
  if (reported.truncated) {
    failures.push(
      `GitLab now reports changes_count "${reported.truncated}" for this MR — truncation is live, so this cell must assert the refusal path again (see tests/gather.test.ts for the shape)`,
    );
  }
  const expected = reported.count ?? null;
  const cwd = checkoutFor('gitlab');
  const gathers = [
    ['the fixture checkout', cwd, 'filelist-gather.json'],
    // From an unrelated directory too: a COMPLETE list needs no checkout to
    // corroborate it, so this must succeed and agree file for file.
    ['an unrelated directory', mkdtempSync(join(tmpdir(), 'acc-unrelated-')), 'filelist-elsewhere.json'],
  ];
  const seen = [];
  for (const [where, dir, artifact] of gathers) {
    try {
      run(process.execPath, [CLI, 'gather', prUrl, '--no-cache', '--out', join(outDir, artifact)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const gather = readArtifact(outDir, artifact);
      const files = gather?.changedFiles?.length ?? 0;
      if (gather?.changedFilesComplete !== true) failures.push(`gather from ${where} did not mark the file list complete`);
      if (expected != null && files !== expected) {
        failures.push(`gather from ${where} returned ${files} files, provider reports ${expected}`);
      }
      if (files <= 100) failures.push(`gather from ${where} returned ${files} files — at or below one API page, so pagination is not exercised`);
      seen.push(files);
    } catch (err) {
      failures.push(`gather from ${where} failed: ${safeLogValue(String(err.stderr ?? err.message).slice(0, 300))}`);
    }
  }
  if (seen.length === 2 && seen[0] !== seen[1]) {
    failures.push(`the two gathers disagree: ${seen[0]} files from the checkout, ${seen[1]} from an unrelated directory`);
  }

  return { provider: 'gitlab', runtime: '-', case: 'filelist', ok: failures.length === 0, failures, prUrl, files: seen[0] };
}

// --- the matrix ------------------------------------------------------------

const results = [];
const startedAt = new Date().toISOString();

for (const provider of wantProviders) {
  if (!PROVIDERS.includes(provider)) {
    console.error(`unknown provider: ${provider}`);
    process.exit(2);
  }
  if (!wantCases.includes('defects')) continue;
  for (const runtime of wantRuntimes) {
    if (!RUNTIMES.includes(runtime)) {
      console.error(`unknown runtime: ${runtime}`);
      process.exit(2);
    }
    console.log(`\n=== ${provider} / ${runtime} ===`);
    const began = Date.now();
    try {
      const result = await runDefectsCell(provider, runtime);
      results.push({ ...result, durationMs: Date.now() - began });
    } catch (err) {
      // A cell never throws out of the loop: one provider being down must not
      // hide the verdict for the other five.
      results.push({ provider, runtime, case: 'defects', ok: false, failures: [safeLogValue(err.message)], durationMs: Date.now() - began });
    }
    const last = results[results.length - 1];
    console.log(
      last.blocked
        ? `🚧 ${provider}/${runtime} BLOCKED — ${last.blocked}`
        : last.ok
          ? `✓ ${provider}/${runtime}`
          : `✗ ${provider}/${runtime}\n    ${last.failures.join('\n    ')}`,
    );
  }
}

if (wantCases.includes('filelist') && wantProviders.includes('gitlab') && !resetOnly) {
  console.log(`\n=== gitlab / file-list gate ===`);
  const began = Date.now();
  try {
    results.push({ ...(await runFilelistCell()), durationMs: Date.now() - began });
  } catch (err) {
    results.push({ provider: 'gitlab', runtime: '-', case: 'filelist', ok: false, failures: [safeLogValue(err.message)], durationMs: Date.now() - began });
  }
  const last = results[results.length - 1];
  console.log(last.ok ? '✓ gitlab/filelist' : `✗ gitlab/filelist\n    ${last.failures.join('\n    ')}`);
}

const cliVersion = (() => {
  try {
    return run(process.execPath, [CLI, '--version']).trim();
  } catch {
    return 'unknown';
  }
})();

writeFileSync(
  join(outDir, 'acceptance-report.json'),
  JSON.stringify({ startedAt, cliVersion, dryRun, requested: { providers: wantProviders, runtimes: wantRuntimes, cases: wantCases }, results }, null, 2),
  'utf8',
);

// A cell that did not run is reported as a skipped ROW, never left out. The
// docs promise the matrix is always the full 3x2 grid, and an omitted row reads
// as coverage nobody had — which is the whole failure mode this suite exists to
// make impossible.
const notRun = [];
for (const provider of PROVIDERS) {
  for (const runtime of RUNTIMES) {
    if (results.some((r) => r.provider === provider && r.runtime === runtime && r.case === 'defects')) continue;
    const why = !wantProviders.includes(provider)
      ? 'provider not requested'
      : runtime === 'claude'
        ? 'no Anthropic credential here by design — run `npm run acceptance -- --runtime claude` locally'
        : 'runtime not requested';
    notRun.push({ provider, runtime, case: 'defects', skipped: why });
  }
}

const cell = (r) =>
  r.blocked
    ? `| ${r.provider} | ${r.runtime} | ${r.case} | 🚧 blocked | - | - | ${r.blocked.replace(/\|/g, '\\|')} |`
    : r.skipped
    ? `| ${r.provider} | ${r.runtime} | ${r.case} | ⏭️ skip | - | - | ${r.skipped} |`
    : `| ${r.provider} | ${r.runtime} | ${r.case} | ${r.ok ? '✅ pass' : '❌ fail'} | ${r.findings ?? '-'} | ${r.posted ?? '-'} | ${
        r.ok ? '' : r.failures.join('<br>').replace(/\|/g, '\\|')
      } |`;

const md = [
  `# Acceptance matrix — ${cliVersion}${dryRun ? ' (dry-run)' : ''}`,
  '',
  '| provider | runtime | case | result | findings | posted | detail |',
  '|---|---|---|---|---|---|---|',
  ...[...results, ...notRun].map(cell),
  '',
].join('\n');
writeFileSync(join(outDir, 'acceptance-report.md'), md + '\n', 'utf8');

const failed = results.filter((r) => !r.ok);
console.log(`\nreport: ${outDir}`);
if (results.length === 0) {
  // "all 0 cell(s) passed" with exit 0 is the worst possible outcome: a typo in
  // --provider or --case reads as a green matrix.
  console.error('no cell ran — check --provider / --runtime / --case against the matrix');
  process.exit(1);
}
// A blocked cell proved nothing, so it is counted apart from the passes rather
// than folded into them — a tally that hides it is how "we ran the matrix"
// quietly comes to mean less than it sounds.
const blockedCells = results.filter((r) => r.blocked);
const ran = results.length - blockedCells.length;
console.log(
  failed.length === 0 ? `${ran} cell(s) passed, ${blockedCells.length} blocked` : `${failed.length}/${ran} cell(s) FAILED, ${blockedCells.length} blocked`,
);
if (ran === 0) {
  // Every cell blocked is the same outcome as no cell running, and it must not
  // exit 0: in CI that is a green check mark over a matrix that proved nothing.
  // BLOCKED means "not this product's fault", never "fine".
  console.error(`no cell proved anything — all ${blockedCells.length} were blocked`);
  process.exit(1);
}
process.exit(failed.length === 0 ? 0 : 1);
