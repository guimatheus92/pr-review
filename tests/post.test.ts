import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { snapFindingsToDiff } from '../src/commands/post.js';
import type { ChangedFile, Finding } from '../src/types.js';

const PATCH = [
  '@@ -10,4 +10,5 @@',
  ' context line 10',
  '-removed old 11',
  '+added new 11',
  '+added new 12',
  ' context line 13',
].join('\n');

const FILES: ChangedFile[] = [
  { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
];

function finding(file?: string, line?: number): Finding {
  return { severity: 'MEDIUM', title: 't', body: 'the body', file, line };
}

test('snapFindingsToDiff — snaps out-of-range lines, keeps exact hits', () => {
  const input = [finding('src/a.ts', 11), finding('src/a.ts', 3787)];
  const { findings, snapped, reanchored } = snapFindingsToDiff(input, FILES, true);
  assert.equal(snapped, 1);
  assert.equal(reanchored, 0);
  assert.deepEqual(findings.map((f) => f.line), [11, 13]);
});

test('snapFindingsToDiff — reanchor moves findings outside the diff to a valid anchor, keeping the original location in the body', () => {
  const input = [finding('src/not-in-diff.ts', 5), finding()];
  const { findings, reanchored, anchor } = snapFindingsToDiff(input, FILES, true);
  assert.deepEqual(anchor, { file: 'src/a.ts', line: 10 });
  assert.equal(reanchored, 2);
  assert.deepEqual(findings.map((f) => `${f.file}:${f.line}`), ['src/a.ts:10', 'src/a.ts:10']);
  assert.equal(findings[0].body, '`src/not-in-diff.ts:5` — the body');
  assert.equal(findings[1].body, 'the body');
});

test('snapFindingsToDiff — without reanchor (ADO), unanchorable findings pass through untouched', () => {
  const input = [finding('src/not-in-diff.ts', 5), finding()];
  const { findings, reanchored } = snapFindingsToDiff(input, FILES, false);
  assert.equal(reanchored, 0);
  assert.deepEqual(findings, input);
});

// ---- runPost with an injected fake provider (batch, fallback, counting) ----

import { runPost } from '../src/commands/post.js';
import type { PrRef, ReviewerOutput } from '../src/types.js';
import type { BatchComment, PrProvider } from '../src/providers/types.js';

interface FakeCalls {
  batches: BatchComment[][];
  singles: Finding[];
}

function fakeProvider(opts: { batchFails?: boolean; hasBatch?: boolean } = {}): { provider: PrProvider; calls: FakeCalls } {
  const calls: FakeCalls = { batches: [], singles: [] };
  const provider: PrProvider = {
    name: 'github',
    parseUrl: (url: string): PrRef | null => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchFullDiff: async () => '',
    fetchExistingComments: async () => [],
    postLineComment: async (_ref, f) => {
      if (!f.file || !f.line) return null;
      calls.singles.push(f);
      return { id: 'x' };
    },
    ...(opts.hasBatch !== false
      ? {
          postBatchComments: async (_ref: PrRef, _sha: string, comments: BatchComment[]) => {
            if (opts.batchFails) throw new Error('422 batch rejected');
            calls.batches.push(comments);
            return { posted: comments.length };
          },
        }
      : {}),
  };
  return { provider, calls };
}

function gatherFixture() {
  return {
    pr: { provider: 'github' as const, url: 'u', owner: 'o', repo: 'r', number: 1 },
    metadata: {
      title: 't', description: 'd', author: 'a', headSha: 'sha1234567890', baseSha: 'sha0',
      baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [],
      createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const,
    },
    changedFiles: FILES,
    fullDiff: '',
    existingComments: [],
    gatheredAt: '',
  };
}

function wrap(findings: Finding[]): ReviewerOutput[] {
  return [{ reviewerName: 'merged', model: 'm', findings, rawOutput: '', durationMs: 0, exitCode: 0 }];
}

test('runPost — batch success posts every finding in one review, nothing skipped', async () => {
  const { provider, calls } = fakeProvider();
  const input = [finding('src/a.ts', 11), finding('src/not-in-diff.ts', 9), finding()];
  const result = await runPost({ prUrl: 'u', outputs: wrap(input), publish: true, gather: gatherFixture(), provider });
  assert.equal(calls.batches.length, 1);
  assert.equal(calls.batches[0].length, 3, 're-anchored findings ride the same batch');
  assert.equal(result.posted, 3);
  assert.equal(result.attempted, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(calls.singles.length, 0);
});

test('runPost — batch failure falls back to per-comment for ALL inline findings, without double counting', async () => {
  const { provider, calls } = fakeProvider({ batchFails: true });
  const input = [finding('src/a.ts', 11), finding('src/a.ts', 13)];
  const result = await runPost({ prUrl: 'u', outputs: wrap(input), publish: true, gather: gatherFixture(), provider });
  assert.equal(calls.singles.length, 2, 'both findings re-attempted per-comment');
  assert.equal(result.posted, 2);
  assert.equal(result.attempted, 2, 'a failed batch attempt must not inflate attempted');
  assert.equal(result.errors.length, 0);
});

test('runPost — dry-run counts skipped and calls no provider write', async () => {
  const { provider, calls } = fakeProvider();
  const result = await runPost({ prUrl: 'u', outputs: wrap([finding('src/a.ts', 11)]), publish: false, gather: gatherFixture(), provider });
  assert.equal(result.skipped, 1);
  assert.equal(calls.batches.length + calls.singles.length, 0);
});

test('runPost — on publish, a finding the provider cannot place inline becomes an error, never skipped', async () => {
  const { provider } = fakeProvider({ hasBatch: false });
  // no gather → no snapping/reanchoring; the location-less finding hits postLineComment → null
  const result = await runPost({ prUrl: 'u', outputs: wrap([finding()]), publish: true, provider });
  assert.equal(result.skipped, 0, 'skipped exists only for --dry-run');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /inline/);
});

// ---- reconciliation: the write landed but the response was lost ----
//
// These use a fake with SERVER STATE. The fake above decides ground truth by
// throwing, so it cannot express "I threw AND I wrote" — which is the whole
// incident: a 504 arriving after GitHub committed the review, retried blind
// into a secondary rate limit, reported as `posted 0 / errors 56` while all 56
// comments were live, then duplicated by --resume.

import type { ExistingComment } from '../src/types.js';

type BatchBehavior =
  | { kind: 'ok' }
  | { kind: 'throwAfterWriting' }
  | { kind: 'throwWithoutWriting' }
  | { kind: 'throwAfterWritingFirst'; n: number }
  | { kind: 'failThenSucceed' };

interface StatefulFake {
  provider: PrProvider;
  server: ExistingComment[];
  singles: Finding[];
  batchCalls: number;
}

function statefulFake(opts: {
  batch?: BatchBehavior;
  transient?: boolean;
  readThrows?: boolean;
  hideServer?: boolean;
}): StatefulFake {
  const state: StatefulFake = { provider: null as never, server: [], singles: [], batchCalls: 0 };
  let nextId = 1;
  const record = (path: string, line: number, body: string): void => {
    state.server.push({
      id: String(nextId++),
      author: 'me',
      body,
      file: path,
      line,
      createdAt: new Date().toISOString(),
      source: 'human',
    });
  };
  const timeout = (): Error => Object.assign(new Error('gateway timeout'), { status: 504 });
  const behavior: BatchBehavior = opts.batch ?? { kind: 'ok' };

  state.provider = {
    name: 'github',
    authEnv: () => ({}),
    parseUrl: (url: string): PrRef | null => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchFullDiff: async () => '',
    fetchExistingComments: async () => {
      if (opts.readThrows) throw new Error('read failed: 500');
      return opts.hideServer ? [] : state.server.slice();
    },
    ...(opts.transient ? { isTransientError: () => true } : {}),
    postLineComment: async (_ref: PrRef, f: Finding) => {
      if (!f.file || !f.line) return null;
      state.singles.push(f);
      record(f.file, f.line, f.body.trim());
      return { id: 'x' };
    },
    postBatchComments: async (_ref: PrRef, _sha: string, comments: BatchComment[]) => {
      state.batchCalls++;
      const writeAll = (): void => comments.forEach((c) => record(c.path, c.line, c.body));
      switch (behavior.kind) {
        case 'ok':
          writeAll();
          return { posted: comments.length };
        case 'throwAfterWriting':
          writeAll();
          throw timeout();
        case 'throwWithoutWriting':
          throw new Error('422 batch rejected');
        case 'throwAfterWritingFirst':
          comments.slice(0, behavior.n).forEach((c) => record(c.path, c.line, c.body));
          throw timeout();
        case 'failThenSucceed':
          if (state.batchCalls === 1) throw Object.assign(new Error('boom'), { status: 500 });
          writeAll();
          return { posted: comments.length };
      }
    },
  } as unknown as PrProvider;
  return state;
}

// Bodies must differ, or the multiset match cannot tell three comments apart.
const inlineFindings = (): Finding[] =>
  [11, 12, 13].map((line, i) => ({ ...finding('src/a.ts', line), body: `body ${i}` }));

test('runPost — batch throws AFTER the write landed: reconciliation finds the comments, no fallback, no duplicates', async () => {
  const fake = statefulFake({ batch: { kind: 'throwAfterWriting' } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(result.posted, 3, 'a lost response is not a failed write');
  assert.equal(result.errors.length, 0, 'the incident reported 56 errors for 56 live comments');
  assert.equal(result.attempted, 3);
  assert.equal(fake.singles.length, 0, 'the per-comment fallback must not run');
  assert.equal(fake.server.length, 3, 'nothing was posted twice');
});

test('runPost — batch throws having written NOTHING: fallback still runs (the good path is not regressed)', async () => {
  const fake = statefulFake({ batch: { kind: 'throwWithoutWriting' } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.singles.length, 3, 'all three re-attempted per-comment');
  assert.equal(result.posted, 3);
  assert.equal(result.attempted, 3, 'a failed batch attempt must not inflate attempted');
  assert.equal(result.errors.length, 0);
  assert.equal(fake.server.length, 3);
});

test('runPost — batch partially landed: only the missing findings are re-posted', async () => {
  const fake = statefulFake({ batch: { kind: 'throwAfterWritingFirst', n: 2 } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.singles.length, 1, 'only the one that did not land');
  assert.equal(fake.singles[0].body, 'body 2');
  assert.equal(result.posted, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(fake.server.length, 3, 'the two that landed were not written again');
});

test('runPost — a per-comment error whose comment IS on the PR is counted as posted, not as an error', async () => {
  const fake = statefulFake({ batch: { kind: 'throwWithoutWriting' } });
  // Record, then report failure — the lost-response shape, one comment at a time.
  const inner = fake.provider.postLineComment;
  fake.provider.postLineComment = async (ref, f, sha) => {
    await inner(ref, f, sha);
    throw new Error('422 Validation Failed');
  };
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(result.posted, 3, 'the PR is the source of truth, not the POST return');
  assert.equal(result.errors.length, 0);
});

test('runPost — reconciliation never demotes: a posted finding the read cannot see stays posted', async () => {
  // hideServer makes every read come back empty — the stale/eventually-consistent
  // case. Demoting here would mark live comments un-posted and send the next
  // --resume out to write them a second time.
  const fake = statefulFake({ batch: { kind: 'ok' }, hideServer: true });
  const input = [...inlineFindings(), finding()]; // the last one cannot anchor
  const result = await runPost({ prUrl: 'u', outputs: wrap(input), publish: true, provider: fake.provider });

  assert.equal(result.posted, 3, 'the successful batch is not undone by an empty read');
  assert.equal(result.errors.length, 1, 'only the genuinely unanchorable finding');
});

test('runPost — a failing read never turns into a failed post', async () => {
  const fake = statefulFake({ batch: { kind: 'throwWithoutWriting' }, readThrows: true });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(result.posted, 3, 'unverifiable falls back rather than giving up');
  assert.equal(result.errors.length, 0);
});

test('runPost — a transient batch error that landed nothing is retried as a batch, not degraded to per-comment', async () => {
  const fake = statefulFake({ batch: { kind: 'failThenSucceed' }, transient: true });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.batchCalls, 2);
  assert.equal(result.posted, 3);
  assert.equal(fake.singles.length, 0);
  assert.equal(fake.server.length, 3, 'the retry did not duplicate');
});
