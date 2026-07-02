import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { withRetry } from '../src/util/retry.js';

const FAST = [1, 1, 1] as const;
const always = () => true;
const never = () => false;

test('withRetry — success on first try returns immediately', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    return 'ok';
  }, always, 'x', FAST);
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('withRetry — retriable error then success returns the success value', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('transient');
    return 42;
  }, always, 'x', FAST);
  assert.equal(out, 42);
  assert.equal(calls, 3);
});

test('withRetry — non-retriable error throws immediately with no retry', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('fatal');
    }, never, 'x', FAST),
    /fatal/,
  );
  assert.equal(calls, 1);
});

test('withRetry — exhausts the schedule then throws the LAST error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error(`attempt-${calls}`);
    }, always, 'x', FAST),
    /attempt-4/,
  );
  assert.equal(calls, FAST.length + 1);
});
