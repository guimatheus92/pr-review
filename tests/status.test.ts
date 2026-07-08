import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT } from '../src/util/tmp.js';
import { runStatus, statusExitCode } from '../src/commands/status.js';

// status resolves run-id → RUNS_ROOT/<id>; seed test dirs there and clean up.
function seed(id: string): string {
  const dir = join(RUNS_ROOT, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const DEAD_PID = 2147483646; // no process; process.kill(pid,0) → ESRCH

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

test('runStatus — a live pid reports running even with an intermediate phase1 artifact present', () => {
  const id = 'status-test-alive';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(process.pid), 'utf8'); // this test process is alive
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'running', 'a healthy run mid-flight must not read as interrupted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — a dead pid with reviewer output → interrupted (resume it)', () => {
  const id = 'status-test-interrupted';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'interrupted');
    assert.match(r.text, /--resume/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — a dead pid with no findings → failed (poller can stop)', () => {
  const id = 'status-test-failed';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '' }) + '\n', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'failed');
    assert.match(r.text, /detached\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — no run.pid + only a progress feed → running (unknown liveness, keep polling)', () => {
  const id = 'status-test-nopid';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '3 files' }) + '\n', 'utf8');
    const r = runStatus(id, 61_000);
    assert.equal(r.state, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — missing run dir', () => {
  assert.equal(runStatus('status-test-does-not-exist-zzz').state, 'missing');
});

test('statusExitCode — the codes the slash-command poll loop branches on', () => {
  assert.equal(statusExitCode('done'), 0);
  assert.equal(statusExitCode('missing'), 1);
  assert.equal(statusExitCode('running'), 20);
  assert.equal(statusExitCode('interrupted'), 21);
  assert.equal(statusExitCode('failed'), 22);
});
