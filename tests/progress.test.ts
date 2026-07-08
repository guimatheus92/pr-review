import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProgress, readProgress, renderProgressSnapshot, type ProgressEvent } from '../src/util/progress.js';

test('renderProgressSnapshot — last phase, elapsed, reviewer count', () => {
  const events: ProgressEvent[] = [
    { ts: 1000, phase: 'gather', detail: '18 files' },
    { ts: 2000, phase: 'dispatch', detail: '15 reviewers' },
    { ts: 3000, phase: 'reviewer', detail: 'security ✓ (14s)' },
    { ts: 4000, phase: 'reviewer', detail: 'performance ✓ (31s)' },
  ];
  const out = renderProgressSnapshot(events);
  assert.match(out, /reviewer — performance/);
  assert.match(out, /2\/15 done/);
  assert.match(out, /0m03s/); // last.ts - first.ts = 3s
});

test('renderProgressSnapshot — nowMs advances elapsed between polls', () => {
  const out = renderProgressSnapshot([{ ts: 0, phase: 'dispatch', detail: '15 reviewers' }], 65_000);
  assert.match(out, /1m05s/);
});

test('renderProgressSnapshot — empty feed', () => {
  assert.equal(renderProgressSnapshot([]), 'starting…');
});

test('appendProgress/readProgress — round-trip, tolerant of a trailing partial line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-progress-'));
  try {
    appendProgress(dir, 'gather', '3 files');
    appendProgress(dir, 'done', '');
    const evs = readProgress(dir);
    assert.deepEqual(
      evs.map((e) => e.phase),
      ['gather', 'done'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readProgress — no feed yet → empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-progress-'));
  try {
    assert.deepEqual(readProgress(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
