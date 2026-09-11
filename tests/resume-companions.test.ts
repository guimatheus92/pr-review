import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resumedCompanionFailures } from '../src/commands/review.js';

/**
 * The resume paths never passed `operationalFailures` to `finalizeReview`, so a
 * run resumed after losing a companion agent could report exit 0 over
 * incomplete delivery — "a parseable review is not a completed review" held on
 * fresh runs only. These pin the re-read that closes it, including the two ways
 * it could quietly re-open.
 */

function runDir(companions?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-resume-companions-'));
  if (companions !== undefined) writeFileSync(join(dir, 'companions.json'), companions, 'utf8');
  return dir;
}

test('resumedCompanionFailures — a missing companion is an operational failure on resume too', () => {
  const dir = runDir(JSON.stringify({ missingReviewers: ['companion:code-review'], duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), ["planned companion 'companion:code-review' produced no output"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — duplicates count too, and both kinds are reported together', () => {
  const dir = runDir(JSON.stringify({ missingReviewers: ['a'], duplicateReviewers: ['b'] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), [
      "planned companion 'a' produced no output",
      "companion 'b' produced duplicate outputs",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a clean artifact reports nothing', () => {
  const dir = runDir(JSON.stringify({ missingReviewers: [], duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — an ABSENT artifact is benign (runs predating it must still resume)', () => {
  const dir = runDir();
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — an UNREADABLE artifact is unknown, never "no failures"', () => {
  const dir = runDir('{ this is not json');
  try {
    const failures = resumedCompanionFailures(dir, []);
    assert.equal(failures.length, 1, 'swallowing the parse error reinstates the exact bug this exists to fix');
    assert.match(failures[0]!, /companions\.json is unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a non-array field is ignored rather than crashing the resume', () => {
  const dir = runDir(JSON.stringify({ missingReviewers: 'oops', duplicateReviewers: [7, 'b'] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), ["companion 'b' produced duplicate outputs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The re-read above was half the fix. A resume DOES re-dispatch unresolved
 * reviewers, companions included, but `writeCompanionArtifact` lives in
 * `runReview` and is unreachable from the resume paths — so `companions.json`
 * kept the interrupted attempt's verdict while the recovered outputs sat in the
 * same run dir. Observed on PrecoPratico-Backend#715 and Frontend#1173: seven
 * `raw-companion_*.json` written by the resume, seven companion rows in the
 * summary with their findings, and the run still exited 2 naming all seven as
 * having produced no output. Worse than the bug it mirrors: INV-DEL-03 refuses
 * to post an incomplete delivery, so a COMPLETE review goes unposted.
 *
 * The reconciliation is one-way, INV-POST-04's rule applied here: a recorded
 * failure may be cleared by evidence, never created from its absence.
 */
function output(reviewerName: string) {
  return { reviewerName, model: 'm', findings: [], rawOutput: '[]', durationMs: 1, exitCode: 0 };
}

const PLANNED = ['companion:pr-review-toolkit/code-reviewer', 'companion:code-review'];

test('resumedCompanionFailures — a companion the RESUME delivered is not a failure', () => {
  const dir = runDir(JSON.stringify({
    plannedReviewers: PLANNED,
    completedDispatches: 0,
    completedReviewers: [],
    missingReviewers: PLANNED,
    duplicateReviewers: [],
  }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, PLANNED.map(output)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — the stale verdict is written back, so the artifact stops lying', () => {
  const dir = runDir(JSON.stringify({
    runtime: 'claude',
    plannedDispatches: 2,
    plannedReviewers: PLANNED,
    completedDispatches: 0,
    completedReviewers: [],
    missingReviewers: PLANNED,
    duplicateReviewers: [],
  }));
  try {
    resumedCompanionFailures(dir, PLANNED.map(output));
    const written = JSON.parse(readFileSync(join(dir, 'companions.json'), 'utf8'));
    assert.equal(written.completedDispatches, 2);
    assert.deepEqual(written.completedReviewers, PLANNED);
    assert.deepEqual(written.missingReviewers, []);
    assert.deepEqual(written.duplicateReviewers, []);
    // `pr-review verify` grades INV-DEL-01 from these very fields, so a stale
    // artifact fails the audit of a run that behaved correctly.
    assert.equal(written.runtime, 'claude', 'unrelated fields must survive the rewrite');
    assert.equal(written.plannedDispatches, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a companion the resume did NOT deliver stays a failure', () => {
  const dir = runDir(JSON.stringify({ plannedReviewers: PLANNED, missingReviewers: PLANNED, duplicateReviewers: [] }));
  try {
    // Only the one this resume holds is cleared. Clearing the whole record on
    // any delivery is how a partial recovery starts reporting a clean pipeline.
    assert.deepEqual(resumedCompanionFailures(dir, [output(PLANNED[0]!)]), [
      "planned companion 'companion:code-review' produced no output",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — plannedReviewers is authoritative even when the recorded verdict claims complete', () => {
  const dir = runDir(JSON.stringify({ plannedReviewers: PLANNED, missingReviewers: [], duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), [
      "planned companion 'companion:pr-review-toolkit/code-reviewer' produced no output",
      "planned companion 'companion:code-review' produced no output",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a modern malformed roster fails closed', () => {
  const dir = runDir(JSON.stringify({ plannedReviewers: 'not-an-array', missingReviewers: [], duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), [
      'companions.json has an invalid plannedReviewers roster — companion delivery cannot be accounted for',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a modern one-to-one delivery is complete regardless of a stale verdict', () => {
  const dir = runDir(JSON.stringify({
    plannedDispatches: 1,
    plannedReviewers: [PLANNED[1]],
    completedReviewers: [],
    missingReviewers: [PLANNED[1]],
    duplicateReviewers: [],
  }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, [output(PLANNED[1]!)]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a planned name delivered TWICE is a duplicate failure', () => {
  const dir = runDir(JSON.stringify({
    plannedReviewers: [PLANNED[0]],
    missingReviewers: [PLANNED[0]],
    duplicateReviewers: [],
  }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, [output(PLANNED[0]!), output(PLANNED[0]!)]), [
      "companion 'companion:pr-review-toolkit/code-reviewer' produced duplicate outputs",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a recorded duplicate clears only when the resume delivered it once', () => {
  const dir = runDir(JSON.stringify({ plannedReviewers: [PLANNED[0]], missingReviewers: [], duplicateReviewers: [PLANNED[0]] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, [output(PLANNED[0]!)]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a recorded duplicate still delivered twice stays a failure', () => {
  const dir = runDir(JSON.stringify({ plannedReviewers: [PLANNED[0]], missingReviewers: [], duplicateReviewers: [PLANNED[0]] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, [output(PLANNED[0]!), output(PLANNED[0]!)]), [
      "companion 'companion:pr-review-toolkit/code-reviewer' produced duplicate outputs",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — called with no outputs, every recorded failure survives', () => {
  // The old signature's behaviour, preserved: a caller that passes nothing must
  // not have its failures silently cleared.
  const dir = runDir(JSON.stringify({ plannedReviewers: PLANNED, missingReviewers: PLANNED, duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, []), [
      "planned companion 'companion:pr-review-toolkit/code-reviewer' produced no output",
      "planned companion 'companion:code-review' produced no output",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — pass outputs never satisfy a planned companion', () => {
  const dir = runDir(JSON.stringify({ plannedReviewers: [PLANNED[1]], missingReviewers: [PLANNED[1]], duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, [output('owasp/logging'), output('verifier')]), [
      "planned companion 'companion:code-review' produced no output",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — an artifact with no plannedReviewers reconciles the same way', () => {
  // `plannedReviewers` is not what the reconciliation reads; the recorded
  // missing/duplicate lists are. So an artifact written before this change is
  // recovered too, which is the whole point — the two runs that exposed the bug
  // are already on disk.
  const dir = runDir(JSON.stringify({ missingReviewers: ['companion:code-review'], duplicateReviewers: [] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir, [output('companion:code-review')]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
