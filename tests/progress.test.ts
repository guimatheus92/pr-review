import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProgress, readProgress, renderProgressSnapshot, type ProgressEvent } from '../src/util/progress.js';

test('renderProgressSnapshot — last phase + detail + elapsed', () => {
  const events: ProgressEvent[] = [
    { ts: 1000, phase: 'gather', detail: '18 files' },
    { ts: 2000, phase: 'dispatch', detail: '6 reviewers' },
    { ts: 4000, phase: 'running', detail: 'orchestrator 120s' },
  ];
  const out = renderProgressSnapshot(events);
  assert.match(out, /running — orchestrator 120s/);
  assert.match(out, /0m03s/); // last.ts - first.ts = 3s
});

test('renderProgressSnapshot — nowMs advances elapsed between polls', () => {
  const out = renderProgressSnapshot([{ ts: 0, phase: 'dispatch', detail: '6 reviewers' }], 65_000);
  assert.match(out, /1m05s/);
});

test('renderProgressSnapshot — a reap line never replaces where the run got to', () => {
  const reap: ProgressEvent = { ts: 9000, phase: 'reap', detail: 'run process died — killed its orphaned runtime session (node pid 7)' };
  const out = renderProgressSnapshot([{ ts: 1000, phase: 'gather', detail: '18 files' }, { ts: 2000, phase: 'dispatch', detail: '6 reviewers' }, reap]);
  assert.match(out, /dispatch — 6 reviewers/);
  assert.doesNotMatch(out, /orphaned/);
  // A feed with nothing else still shows it rather than nothing.
  assert.match(renderProgressSnapshot([reap]), /reap — run process died/);
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
