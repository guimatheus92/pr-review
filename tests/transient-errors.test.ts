import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { isTransientGitHubError } from '../src/providers/github.js';
import { isTransientAdoError } from '../src/providers/azuredevops.js';

function err(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

test('isTransientGitHubError — the retry contract, branch by branch', () => {
  // 5xx: always transient
  assert.equal(isTransientGitHubError(err('boom', { status: 500 })), true);
  assert.equal(isTransientGitHubError(err('boom', { status: 502 })), true);
  // 403: only rate-limit / secondary-limit wording
  assert.equal(isTransientGitHubError(err('You have exceeded a secondary rate limit', { status: 403 })), true);
  assert.equal(isTransientGitHubError(err('API rate limit exceeded', { status: 403 })), true);
  assert.equal(isTransientGitHubError(err('Resource not accessible by integration', { status: 403 })), false);
  // 422: only the burst-quota signature
  assert.equal(isTransientGitHubError(err('Validation Failed: line could not be resolved', { status: 422 })), true);
  assert.equal(isTransientGitHubError(err('pull_request_review_thread.line invalid', { status: 422 })), true);
  assert.equal(isTransientGitHubError(err('Validation Failed: path is invalid', { status: 422 })), false);
  // signature match without status property (message-only errors)
  assert.equal(isTransientGitHubError(err('HTTP 422: could not be resolved')), true);
  // everything else fails fast
  assert.equal(isTransientGitHubError(err('Not Found', { status: 404 })), false);
  assert.equal(isTransientGitHubError(err('Bad credentials', { status: 401 })), false);
});

test('isTransientAdoError — 429/5xx via statusCode OR status', () => {
  assert.equal(isTransientAdoError(err('throttled', { statusCode: 429 })), true);
  assert.equal(isTransientAdoError(err('server', { statusCode: 503 })), true);
  // library surfacing the code under `status` must not kill retries
  assert.equal(isTransientAdoError(err('throttled', { status: 429 })), true);
  assert.equal(isTransientAdoError(err('server', { status: 500 })), true);
  assert.equal(isTransientAdoError(err('bad request', { statusCode: 400 })), false);
  assert.equal(isTransientAdoError(err('no status at all')), false);
});
