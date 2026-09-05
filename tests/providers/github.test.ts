import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { apiBaseFor, GitHubProvider } from '../../src/providers/github.js';
import type { Finding, PrRef } from '../../src/types.js';

const REF: PrRef = {
  provider: 'github',
  url: 'https://github.com/o/r/pull/1',
  owner: 'o',
  repo: 'r',
  number: 1,
};

/**
 * Seed the provider's client cache so no token is ever resolved and no request
 * leaves the process. Without this seam the two posting methods are reachable
 * only through a live API, which is why re-wrapping them in `withRetry` — the
 * precise regression the docs warn against — would leave the whole suite green.
 */
function withStubClient(pulls: Record<string, unknown>): GitHubProvider {
  const provider = new GitHubProvider();
  (provider as unknown as { clients: Map<string, unknown> }).clients.set(apiBaseFor(REF), { pulls });
  return provider;
}

const transient = (): Error => Object.assign(new Error('boom'), { status: 500 });

test('postBatchComments — ONE attempt, even on a transient error', async () => {
  // Retrying createReview blind is what tripped the secondary rate limit: the
  // write had already been committed. runPost owns retry because only it can
  // reconcile against the PR first.
  let calls = 0;
  const provider = withStubClient({
    createReview: async () => {
      calls++;
      throw transient();
    },
  });
  await assert.rejects(
    () => provider.postBatchComments(REF, 'sha', [{ path: 'a.ts', line: 1, body: 'b' }]),
    /boom/,
  );
  assert.equal(calls, 1, 'a 500 is transient by isTransientGitHubError — a retry wrapper would make this 4');
});

test('postBatchComments — sends a body-less COMMENT review with RIGHT-side inline comments', async () => {
  // Pins the argument shape, which was asserted nowhere: a review body renders
  // an extra "left a comment" box, and any event other than COMMENT would
  // approve or block on the author's behalf.
  let seen: Record<string, unknown> | undefined;
  const provider = withStubClient({
    createReview: async (args: Record<string, unknown>) => {
      seen = args;
      return { data: { id: 1 } };
    },
  });
  const out = await provider.postBatchComments(REF, 'sha1', [{ path: 'a.ts', line: 7, body: 'finding' }]);

  assert.equal(out.posted, 1);
  assert.equal(seen!.event, 'COMMENT');
  assert.equal(seen!.commit_id, 'sha1');
  assert.equal('body' in seen!, false, 'no review body — findings appear inline only');
  assert.deepEqual(seen!.comments, [{ path: 'a.ts', line: 7, side: 'RIGHT', body: 'finding' }]);
});

test('postBatchComments — an empty batch is a no-op, not an API call', async () => {
  let calls = 0;
  const provider = withStubClient({
    createReview: async () => {
      calls++;
      return { data: { id: 1 } };
    },
  });
  assert.deepEqual(await provider.postBatchComments(REF, 'sha', []), { posted: 0 });
  assert.equal(calls, 0);
});

test('postLineComment — ONE attempt, same rule as the batch', async () => {
  let calls = 0;
  const provider = withStubClient({
    createReviewComment: async () => {
      calls++;
      throw transient();
    },
  });
  const finding: Finding = { severity: 'HIGH', title: 't', body: 'b', file: 'a.ts', line: 3 };
  await assert.rejects(() => provider.postLineComment(REF, finding, 'sha'), /boom/);
  assert.equal(calls, 1, 'a 504 arriving after the comment was committed must not be re-issued here');
});

test('postLineComment — a finding with no location is null, never a top-level comment', async () => {
  const provider = withStubClient({
    createReviewComment: async () => {
      throw new Error('must not be called');
    },
  });
  const out = await provider.postLineComment(REF, { severity: 'LOW', title: 't', body: 'b' }, 'sha');
  assert.equal(out, null);
});

const PR_STUB = {
  title: 't', body: '', user: { login: 'u' }, head: { sha: 'h', ref: 'f' }, base: { sha: 'b', ref: 'main' },
  labels: [], created_at: 'c', updated_at: 'u', draft: false, merged: false, state: 'open',
};

test('fetchMetadata — carries the PR\'s own changed-file count so gather can refuse a truncated list', async () => {
  // pulls/files stops at 3000 entries with no error and no `next` link (verified live: nodejs/node#62088
  // lists 3000 of 4857); changed_files reports the real total, so the count comparison is the guard.
  const provider = withStubClient({ get: async () => ({ data: { ...PR_STUB, changed_files: 3456 } }) });
  const meta = await provider.fetchMetadata(REF);
  assert.equal(meta.changedFileCount, 3456);
  assert.equal(meta.changedFileListTruncated, undefined, 'GitHub never declares truncation; the count comparison does');
});

test('fetchFullDiff — never calls the API (the diff media type 406s above 300 files; nothing reads fullDiff)', async () => {
  const provider = withStubClient({ get: async () => { throw new Error('must not be called'); } });
  assert.equal(await provider.fetchFullDiff(REF), '');
});

test('fetchChangedFiles — maps every GitHub status at the call site, so re-adding the #29 cast fails here', async () => {
  // mapGitHubStatus was unit-tested from the start, but the line that actually had
  // the bug — `status: mapGitHubStatus(f.status)` inside this loop — was not. A cast
  // put back on that line left the whole suite green.
  const raw: [string, string][] = [
    ['added', 'added'],
    ['removed', 'deleted'],
    ['modified', 'modified'],
    ['renamed', 'renamed'],
    ['copied', 'added'],
    ['changed', 'modified'],
    ['unchanged', 'modified'],
  ];
  // fetchChangedFiles drives paginate.iterator, which hangs off the client itself
  // rather than off `pulls` — so the client is seeded directly here.
  const provider = new GitHubProvider();
  (provider as unknown as { clients: Map<string, unknown> }).clients.set(apiBaseFor(REF), {
    pulls: { listFiles: () => {} },
    paginate: {
      iterator: () => ({
        async *[Symbol.asyncIterator]() {
          yield {
            data: raw.map(([status], i) => ({
              filename: `f${i}.ts`,
              status,
              previous_filename: status === 'renamed' ? 'old.ts' : undefined,
              additions: 1,
              deletions: 0,
              patch: '@@ -0,0 +1 @@\n+x',
            })),
          };
        },
      }),
    },
  });

  const files = await provider.fetchChangedFiles(REF);
  assert.equal(files.length, raw.length);
  assert.deepEqual(
    files.map((f) => f.status),
    raw.map(([, expected]) => expected),
  );
  assert.equal(files.find((f) => f.status === 'renamed')!.previousPath, 'old.ts');
});
