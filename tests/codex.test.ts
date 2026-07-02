import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapCodexResult } from '../src/dispatch/codex.js';

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
