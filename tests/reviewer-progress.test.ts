import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendReviewerProgress, readReviewerProgress, REVIEWER_PROGRESS_FILE } from '../src/dispatch/reviewer-progress.js';

function captureStderr<T>(run: () => T): { value: T; stderr: string } {
  const original = process.stderr.write;
  let stderr = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: run(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

test('appendReviewerProgress/readReviewerProgress — round-trip, tolerant of a trailing partial line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-reviewer-progress-'));
  try {
    appendReviewerProgress(dir, { kind: 'session-attempt-started', attempt: 1, ts: 1000 });
    appendReviewerProgress(dir, { kind: 'output-first-seen', reviewer: 'owasp/logging', attempt: 1, bytes: 12, ts: 2000 });
    writeFileSync(join(dir, REVIEWER_PROGRESS_FILE), '{"ts":3000,"kind":"output-ad', { flag: 'a' });
    assert.deepEqual(
      readReviewerProgress(dir).map((e) => [e.ts, e.kind, e.reviewer ?? null]),
      [
        [1000, 'session-attempt-started', null],
        [2000, 'output-first-seen', 'owasp/logging'],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendReviewerProgress — a timeline that cannot be written is named once on stderr, and delivery goes on', () => {
  // INV-OUT-02 lists reviewer-progress.ndjson as a contract artifact and the live mod reads it;
  // a silent catch would leave `verify` failing a run whose log never said why.
  const missing = join(tmpdir(), 'pr-reviewer-progress-' + process.pid + '-does-not-exist');
  const first = captureStderr(() => appendReviewerProgress(missing, { kind: 'session-attempt-started', attempt: 1 }));
  const second = captureStderr(() => appendReviewerProgress(missing, { kind: 'output-first-seen', reviewer: 'x', attempt: 1 }));
  assert.match(first.stderr, /^\[reviewer-progress\] could not append .*reviewer-progress\.ndjson: /);
  assert.equal(second.stderr, '', 'one warning per run directory, not one per event');
  // A different run directory warns on its own.
  const other = captureStderr(() => appendReviewerProgress(missing + '-other', { kind: 'session-attempt-started', attempt: 1 }));
  assert.match(other.stderr, /^\[reviewer-progress\] could not append /);
});
