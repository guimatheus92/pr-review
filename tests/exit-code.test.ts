import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { decideExitCode } from '../src/commands/review.js';
import type { Finding } from '../src/types.js';

function f(severity: Finding['severity']): Finding {
  return { severity, title: 't', body: 'b' };
}

test('decideExitCode — 2 wins over everything: no parseable findings is never a clean PR', () => {
  assert.equal(decideExitCode(true, [f('CRITICAL')], 'HIGH'), 2);
  assert.equal(decideExitCode(true, [], undefined), 2);
});

test('decideExitCode — 1 when findings at/above --fail-on survive', () => {
  assert.equal(decideExitCode(false, [f('CRITICAL')], 'HIGH'), 1);
  assert.equal(decideExitCode(false, [f('HIGH')], 'HIGH'), 1);
});

test('decideExitCode — 0 when below threshold or no threshold given', () => {
  assert.equal(decideExitCode(false, [f('MEDIUM')], 'HIGH'), 0);
  assert.equal(decideExitCode(false, [f('CRITICAL')], undefined), 0);
  assert.equal(decideExitCode(false, [], 'NIT'), 0);
});
