// Eval harness for the review pipeline (issue #5): run known diffs through the
// REAL pipeline (packs + stack detection + pass selection + a live runtime) and
// assert that the findings contain what a competent review must find.
//
//   node scripts/eval.mjs [case] [-- extra review argv, e.g. --runtime claude]
//
// Prereqs: `npm run build` (uses dist/cli.cjs, the artifact users run), a
// runtime CLI on PATH (copilot or claude), and `pr-review packs sync` done at
// least once (the passes come from the synced packs). Manual/pre-release — not
// part of `npm run test` (scripts/test.mjs only walks tests/).
//
// Each fixture: evals/fixtures/<case>/diff.patch + expected.yaml
//   expected.yaml: findings + optional pass/stack assertions (see fixtures).
// Every regex (case-insensitive) must match `title\n body` of at least one
// finding — in the named pass when `pass` is given, anywhere otherwise.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { gatherFromPatch } from './gather-from-patch.mjs';
import {
  hasEvalAssertions,
  matchExpectedFindings,
  requiredEvalArtifacts,
  safeLogValue,
  stackExpectationFailures,
} from './eval-assertions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'dist', 'cli.cjs');
const FIXTURES = join(ROOT, 'evals', 'fixtures');
const PLACEHOLDER_PR = 'https://github.com/pr-review/eval/pull/1';

function parseArgs(argv) {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const extra = sep === -1 ? [] : argv.slice(sep + 1);
  return { caseName: own[0], extra };
}

function runCase(name, extra) {
  const dir = join(FIXTURES, name);
  const patchText = readFileSync(join(dir, 'diff.patch'), 'utf8');
  const expected = parseYaml(readFileSync(join(dir, 'expected.yaml'), 'utf8'));
  const runDir = mkdtempSync(join(tmpdir(), `pr-review-eval-${name}-`));
  const gatherFile = join(runDir, 'eval-gather.json');
  writeFileSync(
    gatherFile,
    JSON.stringify(gatherFromPatch(patchText, { pr: { url: PLACEHOLDER_PR } }), null, 2),
    'utf8',
  );

  const argv = [
    CLI,
    'review',
    PLACEHOLDER_PR,
    '--from-gather',
    gatherFile,
    '--dry-run',
    '--no-cache',
    '--no-companions',
    '--run-dir',
    runDir,
    ...extra,
  ];
  console.log(`\n=== ${name} ===`);
  let exitCode = 0;
  let executionFailure = '';
  try {
    execFileSync(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'], timeout: 30 * 60 * 1000 });
  } catch (err) {
    exitCode = err.status ?? 1;
    executionFailure = [
      `status=${String(err.status ?? 'none')}`,
      `code=${String(err.code ?? 'none')}`,
      `signal=${String(err.signal ?? 'none')}`,
      `killed=${String(err.killed ?? false)}`,
      `message=${safeLogValue(err.message ?? err)}`,
    ].join(', ');
    console.error(`  review process failed: ${executionFailure}`);
  }

  // Which runtime actually hosted the session. `--runtime auto` means the argv
  // above cannot answer that, so read it back from the artifact the run wrote —
  // otherwise a claude-vs-copilot comparison has nothing to key results on.
  try {
    const { runtime } = JSON.parse(readFileSync(join(runDir, 'capabilities.json'), 'utf8'));
    if (runtime) console.log(`  runtime: ${runtime}`);
  } catch {
    // A run that failed before writing capabilities.json reports below anyway.
  }

  const missingArtifacts = requiredEvalArtifacts(expected).filter((artifact) => !existsSync(join(runDir, artifact)));
  if (missingArtifacts.length > 0) {
    console.error(
      `✗ ${name}: missing required artifact(s): ${missingArtifacts.join(', ')} (review exit ${exitCode}${executionFailure ? `; ${executionFailure}` : ''}); artifacts: ${runDir}`,
    );
    return false;
  }
  const findingsPath = join(runDir, 'pr-review-findings.json');
  const findings = JSON.parse(readFileSync(findingsPath, 'utf8'));
  const allFindings = findings.finalFindings ?? [];
  const inScope = expected.pass
    ? (findings.reviewers ?? [])
        .filter((r) => r.reviewer === expected.pass || r.reviewer.endsWith(`/${expected.pass}`))
        .flatMap((r) => r.findings)
    : allFindings;

  let ok = true;
  if (exitCode === 2) {
    console.error('  ✗ review pipeline exited 2; findings cannot make this fixture pass');
    ok = false;
  }
  if (!hasEvalAssertions(expected)) {
    console.error(`  x ${name}: expected.yaml has no assertions - a fixture that asserts nothing proves nothing`);
    return false;
  }
  for (const { pattern, finding: hit } of matchExpectedFindings(
    expected?.must_find ?? [],
    inScope,
    expected?.distinct_findings === true,
  )) {
    if (hit) {
      console.log(`  ✓ ${safeLogValue(pattern)} → ${safeLogValue(hit.title)}`);
    } else {
      console.error(
        `  ✗ ${safeLogValue(pattern)} not found in ${inScope.length} finding(s)` +
          (expected.pass ? ` of pass ${safeLogValue(expected.pass)}` : ''),
      );
      ok = false;
    }
  }
  for (const { pattern, finding: hit } of matchExpectedFindings(expected?.must_not_find ?? [], allFindings)) {
    if (hit) {
      console.error(`  ✗ forbidden ${safeLogValue(pattern)} → ${safeLogValue(hit.title)}`);
      ok = false;
    } else {
      console.log(`  ✓ forbidden ${safeLogValue(pattern)} absent`);
    }
  }

  const passesPath = join(runDir, 'passes.json');
  const routes = existsSync(passesPath) ? JSON.parse(readFileSync(passesPath, 'utf8')) : [];
  const dispatched = routes
    .filter((route) => !['context', 'index', 'skipped'].includes(route.matchedBy))
    .map((route) => route.name);
  const hasPass = (expectedName) => dispatched.some((name) => name === expectedName || name.endsWith(`/${expectedName}`));
  for (const expectedPass of expected?.must_dispatch ?? []) {
    if (hasPass(expectedPass)) console.log(`  ✓ dispatched ${safeLogValue(expectedPass)}`);
    else {
      console.error(`  ✗ required pass ${safeLogValue(expectedPass)} not dispatched`);
      ok = false;
    }
  }
  for (const forbiddenPass of expected?.must_not_dispatch ?? []) {
    if (!hasPass(forbiddenPass)) console.log(`  ✓ forbidden pass ${safeLogValue(forbiddenPass)} absent`);
    else {
      console.error(`  ✗ forbidden pass ${safeLogValue(forbiddenPass)} dispatched`);
      ok = false;
    }
  }

  const stackPath = join(runDir, 'stack.json');
  const stack = existsSync(stackPath) ? JSON.parse(readFileSync(stackPath, 'utf8')) : {};
  const stackFailures = stackExpectationFailures(expected, stack);
  for (const failure of stackFailures) {
    console.error(`  ✗ ${failure}`);
    ok = false;
  }
  if (stackFailures.length === 0 && (expected.stack || expected.dependencies)) {
    console.log('  ✓ categorized stack/dependency expectations');
  }
  if (ok) rmSync(runDir, { recursive: true, force: true });
  else console.error(`  artifacts kept at ${runDir}`);
  return ok;
}

const { caseName, extra } = parseArgs(process.argv.slice(2));
if (!existsSync(CLI)) {
  console.error('dist/cli.cjs not found — run `npm run build` first.');
  process.exit(1);
}
const cases = caseName ? [caseName] : readdirSync(FIXTURES);
let failures = 0;
for (const c of cases) {
  if (!runCase(c, extra)) failures++;
}
console.log(failures === 0 ? `\nall ${cases.length} eval case(s) passed` : `\n${failures}/${cases.length} eval case(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
