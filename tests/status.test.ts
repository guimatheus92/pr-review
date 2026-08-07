import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_FILE, RUNS_ROOT } from '../src/util/tmp.js';
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

test('runStatus — a corrupt findings file reads failed (error.txt inline), never a dead-end interrupted', () => {
  const id = 'status-test-corrupt-findings';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    // The orchestrator-flake class: a truncated final write left unparseable JSON.
    writeFileSync(join(dir, 'single-session-findings.json'), '{"reviewers":[{"name":"qual', 'utf8');
    writeFileSync(join(dir, ERROR_FILE), 'pipeline failure: NOT a clean PR\n', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'failed', 'resume cannot load this file — interrupted would hint a dead-end --resume');
    assert.match(r.text, /NOT a clean PR/, 'the recorded error must surface');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — corrupt final file but a valid phase1 fallback → interrupted (resume genuinely works)', () => {
  const id = 'status-test-corrupt-with-phase1';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'single-session-findings.json'), '{"reviewers":[{"na', 'utf8');
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'interrupted', 'resumeReview falls back to phase1 — the hint is honest here');
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

test('runStatus — failed run with error.txt surfaces the recorded error inline', () => {
  const id = 'status-test-failed-error';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '' }) + '\n', 'utf8');
    writeFileSync(join(dir, ERROR_FILE), 'Error: boom\n  at gather (x.ts:1)\n', 'utf8');
    const r = runStatus(id);
    assert.equal(r.state, 'failed');
    assert.match(r.text, /Error: boom/, 'recorded fatal error is inlined');
    assert.match(r.text, /detached\.log/, 'log pointer still present alongside the inline error');
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
