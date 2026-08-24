import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_FAILURE_LOG,
  createCapture,
  formatCodexFailureLog,
  mapCodexResult,
  runCodexReviewer,
} from '../src/dispatch/codex.js';

const RAW = '[{"severity":"HIGH","title":"t","body":"b","file":"a.ts","line":1}]';

test('mapCodexResult — clean exit with findings: no error', () => {
  const out = mapCodexResult({ exitCode: 0, timedOut: false, raw: RAW, durationMs: 5 });
  assert.equal(out.findings.length, 1);
  assert.equal(out.error, undefined);
});

test('mapCodexResult — nonzero exit with NO findings: errored, empty', () => {
  const out = mapCodexResult({ exitCode: 3, timedOut: false, raw: '', durationMs: 5 });
  assert.equal(out.findings.length, 0);
  assert.match(out.error!, /exited 3/);
});

test('mapCodexResult — nonzero exit WITH findings: findings kept but error set (never reported clean)', () => {
  const out = mapCodexResult({ exitCode: 137, timedOut: false, raw: RAW, durationMs: 5 });
  assert.equal(out.findings.length, 1);
  assert.match(out.error!, /exited 137/);
  assert.match(out.error!, /incomplete/);
});

test('mapCodexResult — timeout with partial findings: findings kept but flagged as timed out', () => {
  const out = mapCodexResult({ exitCode: -1, timedOut: true, raw: RAW, durationMs: 5 });
  assert.equal(out.findings.length, 1);
  assert.match(out.error!, /timed out/);
});

test('mapCodexResult — exit 0 with NO output is an errored run, never a clean "found nothing"', () => {
  // codex is contracted to print `[]` when it finds nothing, so empty means the
  // output file was never written. Reporting that as clean loses a whole
  // reviewer silently — the same unknown-as-known-good bug as on the post side.
  const out = mapCodexResult({ exitCode: 0, timedOut: false, raw: '', durationMs: 5, readError: 'ENOENT' });
  assert.equal(out.findings.length, 0);
  assert.match(out.error!, /exited 0 but wrote no output/);
  assert.match(out.error!, /ENOENT/, 'the read failure is the whole story here');
});

test('mapCodexResult — exit 0 with an explicit empty array is clean', () => {
  const out = mapCodexResult({ exitCode: 0, timedOut: false, raw: '[]', durationMs: 5 });
  assert.equal(out.findings.length, 0);
  assert.equal(out.error, undefined);
});

test('createCapture — keeps the head and the tail, elides the middle', () => {
  const cap = createCapture(4, 4);
  cap.push('HEAD');
  cap.push('xxxxxxxxxx');
  cap.push('TAIL');
  const v = cap.value();
  assert.ok(v.startsWith('HEAD'), 'the head carries the usage/flag error');
  assert.ok(v.endsWith('TAIL'), 'the tail carries what it was doing when it died');
  assert.match(v, /10 bytes elided/);
});

test('createCapture — under the budget nothing is elided', () => {
  const cap = createCapture(4, 4);
  cap.push('abc');
  assert.equal(cap.value(), 'abc');
});

test('formatCodexFailureLog — stdout actually reaches the log', () => {
  // Asserting the `--- stdout ---` header alone proves only that a literal was
  // written; it stays green if stdout capture is removed entirely.
  const log = formatCodexFailureLog({
    error: 'codex exec exited 1',
    argv: ['codex', 'exec'],
    exitCode: 1,
    timedOut: false,
    durationMs: 7,
    stdout: 'error: unexpected argument --skip-git-repo-check',
    stderr: 'stderr line',
  });
  assert.match(log, /unexpected argument --skip-git-repo-check/);
  assert.match(log, /stderr line/);
  assert.match(log, /"codex","exec"/);
});

test('runCodexReviewer — an out-of-charset run dir costs one reviewer, not the review', async (t) => {
  // spawnCli validates argv synchronously (win32 only), so this path threw
  // inside the promise executor and the unhandled rejection killed the review.
  // The missing-binary test below takes the async child 'error' path instead,
  // so it never covered this.
  if (process.platform !== 'win32') {
    t.skip('assertSafeArg only runs on the win32 shell path');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'pr-codex-naïve-'));
  try {
    const out = await runCodexReviewer({
      binary: 'codex',
      contextPath: join(dir, 'pr-context.md'),
      outDir: dir,
      timeoutMs: 10_000,
    });
    assert.ok(out.error, 'resolves with an error rather than rejecting');
    assert.equal(out.findings.length, 0);
    assert.ok(existsSync(join(dir, CODEX_FAILURE_LOG)), 'and still leaves the diagnosable artifact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runCodexReviewer — a failed run leaves a diagnosable log behind', async () => {
  // The field case was `codex exec exited 1` with 0 findings and nothing to go
  // on: stdout was discarded, stderr clipped to 300 chars and never persisted,
  // and codex-output.txt — the file the debug skill points at — is exactly what
  // an early exit never writes.
  const dir = mkdtempSync(join(tmpdir(), 'pr-codex-'));
  try {
    const out = await runCodexReviewer({
      binary: 'pr-review-no-such-codex-binary',
      contextPath: join(dir, 'pr-context.md'),
      outDir: dir,
      timeoutMs: 10_000,
    });
    assert.ok(out.error, 'a missing binary is an errored reviewer, not a clean one');
    assert.equal(out.findings.length, 0);

    const logPath = join(dir, CODEX_FAILURE_LOG);
    assert.ok(existsSync(logPath), 'the failure log is the only diagnosable artifact for this path');
    const log = readFileSync(logPath, 'utf8');
    assert.match(log, /argv:/);
    assert.match(log, /--- stderr ---/);
    assert.match(log, /--- stdout ---/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex sandbox argv is pinned — the read-only sandbox is the only posting guard on this path', async () => {
  const { CODEX_SANDBOX_ARGS } = await import('../src/dispatch/codex.js');
  assert.deepEqual([...CODEX_SANDBOX_ARGS], ['exec', '-s', 'read-only', '--skip-git-repo-check']);
});
