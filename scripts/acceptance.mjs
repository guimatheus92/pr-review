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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { matchExpectedFindings, safeLogValue, stackExpectationFailures } from './eval-assertions.mjs';
import { listComments, parsePrUrl, resetPr, resolveToken } from './acceptance-reset.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE = join(ROOT, 'evals', 'acceptance');
const CLI = join(ROOT, 'dist', 'cli.cjs');
const RUNS_ROOT = join(homedir(), '.pr-review', 'runs');
const PROVIDERS = ['github', 'azuredevops', 'gitlab'];
const RUNTIMES = ['claude', 'copilot'];
const CELL_TIMEOUT_MS = 30 * 60 * 1000;

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const wantProviders = flag('provider', PROVIDERS.join(',')).split(',').map((s) => s.trim());
const wantRuntimes = flag('runtime', RUNTIMES.join(',')).split(',').map((s) => s.trim());
const wantCases = flag('case', 'defects,filelist').split(',').map((s) => s.trim());
const dryRun = has('dry-run');
const resetOnly = has('reset-only');
const outDir = flag('out', mkdtempSync(join(tmpdir(), 'pr-review-acceptance-')));
const checkoutRoot = flag('checkout', null);

const matrix = parseYaml(readFileSync(join(ACCEPTANCE, 'matrix.yaml'), 'utf8'));
const expected = parseYaml(readFileSync(join(ACCEPTANCE, 'expected.yaml'), 'utf8'));

if (!existsSync(CLI)) {
  console.error(`dist/cli.cjs is missing — run \`npm run build\` first (the matrix drives the real bundle, not src/)`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

function run(file, args, opts = {}) {
  return execFileSync(file, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    timeout: CELL_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...opts,
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
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['clone', '--no-single-branch', clone, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  }
  checkouts.set(provider, dir);
  return dir;
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
  if (!prUrl) {
    return { provider, runtime, case: 'defects', ok: false, failures: ['no PR URL in matrix.yaml — run scripts/acceptance-seed.mjs'] };
  }

  const cwd = checkoutFor(provider);
  await resetPr(prUrl, { log: (m) => console.log(`  ${m}`) });
  if (resetOnly) return { provider, runtime, case: 'defects', ok: true, failures: [], prUrl, resetOnly: true };

  const argv = [CLI, 'review', prUrl, '--no-cache', '--runtime', runtime, ...(dryRun ? ['--dry-run'] : [])];
  let reviewExit = 0;
  try {
    run(process.execPath, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch (err) {
    reviewExit = err.status ?? 1;
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
    failures.push(`${row.id}: ${row.evidence}`);
  }

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
    if (live.length < posted) failures.push(`${posted} comment(s) reported posted but only ${live.length} are on the PR`);
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
async function runFilelistCell() {
  const prUrl = matrix.providers.gitlab?.wide;
  const failures = [];
  if (!prUrl) return { provider: 'gitlab', runtime: '-', case: 'filelist', ok: false, failures: ['no wide MR URL in matrix.yaml'] };

  const cwd = checkoutFor('gitlab');
  try {
    const out = run(process.execPath, [CLI, 'gather', prUrl, '--no-cache', '--out', join(outDir, 'filelist-gather.json')], { cwd });
    void out;
    const gather = readArtifact(outDir, 'filelist-gather.json');
    if (gather?.changedFilesComplete !== true) failures.push('gather from the fixture checkout did not mark the file list complete');
    if ((gather?.changedFiles?.length ?? 0) < 100) failures.push(`gather returned ${gather?.changedFiles?.length ?? 0} files, expected >= 100`);
  } catch (err) {
    failures.push(`gather from the fixture checkout failed: ${safeLogValue(String(err.stderr ?? err.message).slice(0, 300))}`);
  }

  const elsewhere = mkdtempSync(join(tmpdir(), 'acc-unrelated-'));
  try {
    run(process.execPath, [CLI, 'gather', prUrl, '--no-cache', '--out', join(outDir, 'filelist-negative.json')], { cwd: elsewhere });
    failures.push('gather from an unrelated directory SUCCEEDED — the truncated-list gate did not refuse');
  } catch (err) {
    const stderr = String(err.stderr ?? '') + String(err.stdout ?? '');
    if (!/truncated|not the PR's repository|not inside a git repository|refusing to review an unknown file list/i.test(stderr)) {
      failures.push(`gather refused for an unexpected reason: ${safeLogValue(stderr.slice(0, 300))}`);
    }
  }

  return { provider: 'gitlab', runtime: '-', case: 'filelist', ok: failures.length === 0, failures, prUrl };
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
    console.log(last.ok ? `✓ ${provider}/${runtime}` : `✗ ${provider}/${runtime}\n    ${last.failures.join('\n    ')}`);
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

writeFileSync(join(outDir, 'acceptance-report.json'), JSON.stringify({ startedAt, cliVersion, dryRun, results }, null, 2), 'utf8');

const md = [
  `# Acceptance matrix — ${cliVersion}${dryRun ? ' (dry-run)' : ''}`,
  '',
  '| provider | runtime | case | result | findings | posted | detail |',
  '|---|---|---|---|---|---|---|',
  ...results.map(
    (r) =>
      `| ${r.provider} | ${r.runtime} | ${r.case} | ${r.ok ? '✅ pass' : '❌ fail'} | ${r.findings ?? '-'} | ${r.posted ?? '-'} | ${
        r.ok ? '' : r.failures.join('<br>').replace(/\|/g, '\\|')
      } |`,
  ),
  '',
  ...(wantRuntimes.includes('claude') ? [] : ['> claude cells were not requested in this run.']),
].join('\n');
writeFileSync(join(outDir, 'acceptance-report.md'), md + '\n', 'utf8');

const failed = results.filter((r) => !r.ok);
console.log(`\nreport: ${outDir}`);
console.log(failed.length === 0 ? `all ${results.length} cell(s) passed` : `${failed.length}/${results.length} cell(s) FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
