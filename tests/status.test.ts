import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT } from '../src/util/tmp.js';
import { runStatus } from '../src/commands/status.js';

// status resolves run-id → RUNS_ROOT/<id>; seed test dirs there and clean up.
function seed(id: string): string {
  const dir = join(RUNS_ROOT, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('runStatus — done when the summary is on disk (text IS the summary)', () => {
  const id = 'status-test-done';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'pr-review-summary.md'), '# PR Review Summary\n\nbody', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'done');
    assert.match(r.text, /PR Review Summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — interrupted when reviewer output exists but no summary', () => {
  const id = 'status-test-interrupted';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'dispatch', detail: '15 reviewers' }) + '\n', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'interrupted');
    assert.match(r.text, /--resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — running when only a progress feed exists', () => {
  const id = 'status-test-running';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '3 files' }) + '\n', 'utf8');
    const r = runStatus(id, 61_000);
    assert.equal(r.state, 'running');
    assert.match(r.text, /in progress/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — missing run dir', () => {
  const r = runStatus('status-test-does-not-exist-zzz');
  assert.equal(r.state, 'missing');
});
