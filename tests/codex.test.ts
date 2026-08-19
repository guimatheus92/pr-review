import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_FAILURE_LOG, mapCodexResult, runCodexReviewer } from '../src/dispatch/codex.js';

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
