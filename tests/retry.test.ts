import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isNetworkError, withRetry } from '../src/util/retry.js';
import { isTransientGitLabError } from '../src/providers/gitlab.js';
import { isTransientGitHubError } from '../src/providers/github.js';
import { isTransientAdoError } from '../src/providers/azuredevops.js';

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

test('isNetworkError — a transport failure is transient on every provider', () => {
  // The live defect: `fetch` reports every network failure as the message
  // "fetch failed" with the real code in `cause` and NO `status` property — the
  // only thing the three providers' transient checks read. So the most
  // transient failure there is was classified permanent, and a GitLab cell lost
  // one comment of 57 because runPost's reconcile-then-retry never ran.
  const fetchFailed = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNRESET 172.65.251.78:443'), { code: 'ECONNRESET' }),
  });
  assert.ok(isNetworkError(fetchFailed));
  assert.ok(isTransientGitLabError(fetchFailed), 'gitlab');
  assert.ok(isTransientGitHubError(fetchFailed), 'github');
  assert.ok(isTransientAdoError(fetchFailed), 'azuredevops');

  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.ok(isNetworkError(Object.assign(new Error('nope'), { code })), code);
  }
  assert.ok(isNetworkError(new Error('socket hang up')));

  // A server that ANSWERED is not a network error — those keep their existing
  // per-provider classification, which is what decides retriability for them.
  assert.equal(isNetworkError(Object.assign(new Error('Not Found'), { status: 404 })), false);
  assert.equal(isNetworkError(new Error('position is invalid')), false);
  assert.equal(isTransientGitLabError(Object.assign(new Error('Not Found'), { status: 404 })), false);

  // A cause chain must not be walked forever.
  const circular: { message: string; cause?: unknown } = { message: 'x' };
  circular.cause = circular;
  assert.equal(isNetworkError(circular), false);
});
