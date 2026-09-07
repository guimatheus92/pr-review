import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.deepEqual(resumedCompanionFailures(dir), ["planned companion 'companion:code-review' produced no output"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — duplicates count too, and both kinds are reported together', () => {
  const dir = runDir(JSON.stringify({ missingReviewers: ['a'], duplicateReviewers: ['b'] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir), [
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
    assert.deepEqual(resumedCompanionFailures(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — an ABSENT artifact is benign (runs predating it must still resume)', () => {
  const dir = runDir();
  try {
    assert.deepEqual(resumedCompanionFailures(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — an UNREADABLE artifact is unknown, never "no failures"', () => {
  const dir = runDir('{ this is not json');
  try {
    const failures = resumedCompanionFailures(dir);
    assert.equal(failures.length, 1, 'swallowing the parse error reinstates the exact bug this exists to fix');
    assert.match(failures[0]!, /companions\.json is unreadable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resumedCompanionFailures — a non-array field is ignored rather than crashing the resume', () => {
  const dir = runDir(JSON.stringify({ missingReviewers: 'oops', duplicateReviewers: [7, 'b'] }));
  try {
    assert.deepEqual(resumedCompanionFailures(dir), ["companion 'b' produced duplicate outputs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
