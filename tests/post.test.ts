import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { commentKey, snapFindingsToDiff } from '../src/commands/post.js';
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

test('post source — reconciliation delimiters are escaped text, never literal NUL bytes', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/commands/post.ts', import.meta.url)));
  assert.equal(source.includes(0), false);
  assert.equal(commentKey('a.ts', 7, ' body '), ['a.ts', '7', 'body'].join('\0'));
});

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
    fetchExistingComments: async () => [],
    isTransientError: () => false,
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

test('runPost — posting and reconciliation use the hydrated gather PR project', async () => {
  const gather = gatherFixture();
  gather.pr = {
    provider: 'azuredevops', url: 'https://dev.azure.com/org/_git/r/pullrequest/1',
    owner: 'org', organization: 'org', project: 'Platform', repo: 'r', number: 1,
  };
  const seen: string[] = [];
  const provider: PrProvider = {
    name: 'azuredevops', authEnv: () => ({}),
    parseUrl: (url: string): PrRef => ({
      provider: 'azuredevops', url, owner: 'org', organization: 'org', repo: 'r', number: 1,
    }),
    fetchMetadata: async () => gather.metadata,
    fetchChangedFiles: async () => [],
    fetchExistingComments: async (ref) => {
      seen.push(`read:${ref.project}`);
      return [{
        id: 'landed', author: 'me', body: 'the body', file: 'src/a.ts', line: 11,
        createdAt: new Date().toISOString(), source: 'human',
      }];
    },
    postLineComment: async (ref) => {
      seen.push(`post:${ref.project}`);
      throw Object.assign(new Error('lost response'), { status: 500 });
    },
    isTransientError: () => true,
  };
  const result = await runPost({
    prUrl: gather.pr.url, outputs: wrap([finding('src/a.ts', 11)]), publish: true, gather, provider,
  });
  assert.deepEqual(seen, ['post:Platform', 'read:Platform']);
  assert.equal(result.posted, 1);
  assert.equal(result.verified, true);
  assert.equal(result.errors.length, 0);
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
  /** Write (all, or only the listed indexes) and THEN throw — the lost response. */
  | { kind: 'throwAfterWriting'; only?: number[] }
  | { kind: 'throwWithoutWriting' }
  | { kind: 'alwaysTransient' }
  | { kind: 'failThenSucceed' };

interface StatefulFake {
  provider: PrProvider;
  server: ExistingComment[];
  singles: Finding[];
  batchCalls: number;
  reads: number;
}

function statefulFake(opts: {
  batch?: BatchBehavior;
  transient?: boolean;
  readThrows?: boolean;
  hideServer?: boolean;
  seed?: ExistingComment[];
}): StatefulFake {
  const state: StatefulFake = { provider: null as never, server: [...(opts.seed ?? [])], singles: [], batchCalls: 0, reads: 0 };
  let nextId = 100;
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
    fetchExistingComments: async () => {
      state.reads++;
      if (opts.readThrows) throw Object.assign(new Error('read failed: 502'), { status: 502 });
      return opts.hideServer ? [] : state.server.slice();
    },
    isTransientError: (e: Error) => (opts.transient ? true : (e as { status?: number }).status === 502),
    postLineComment: async (_ref: PrRef, f: Finding) => {
      if (!f.file || !f.line) return null;
      state.singles.push(f);
      record(f.file, f.line, f.body.trim());
      return { id: 'x' };
    },
    postBatchComments: async (_ref: PrRef, _sha: string, comments: BatchComment[]) => {
      state.batchCalls++;
      const write = (idx: number[]): void => idx.forEach((i) => comments[i] && record(comments[i]!.path, comments[i]!.line, comments[i]!.body));
      const all = comments.map((_, i) => i);
      switch (behavior.kind) {
        case 'ok':
          write(all);
          return { posted: comments.length };
        case 'throwAfterWriting':
          write(behavior.only ?? all);
          throw timeout();
        case 'throwWithoutWriting':
          throw new Error('422 batch rejected');
        case 'alwaysTransient':
          throw Object.assign(new Error('boom'), { status: 500 });
        case 'failThenSucceed':
          if (state.batchCalls === 1) throw Object.assign(new Error('boom'), { status: 500 });
          write(all);
          return { posted: comments.length };
      }
    },
  } as unknown as PrProvider;
  return state;
}

/**
 * THE invariant: no path may ever leave two comments at the same location with
 * the same text. Every reconciliation test asserts it, so a regression anywhere
 * in the retry/fallback/promotion logic fails immediately rather than being
 * noticed on a live PR — which is how the 112-comment incident was found.
 */
function assertNoDuplicateComments(fake: StatefulFake): void {
  const seen = new Map<string, number>();
  for (const c of fake.server) {
    const k = `${c.file}:${c.line}:${c.body.trim()}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1);
  assert.deepEqual(dupes, [], `the same review comment was posted more than once: ${JSON.stringify(dupes)}`);
}

const old = (file: string, line: number, body: string, createdAt: string): ExistingComment => ({
  id: `seed-${file}-${line}`,
  author: 'me',
  body,
  file,
  line,
  createdAt,
  source: 'human',
});

// Bodies differ so the multiset can tell the three apart; the same-body case
// gets its own test below.
const inlineFindings = (): Finding[] =>
  [11, 12, 13].map((line, i) => ({ ...finding('src/a.ts', line), body: `body ${i}` }));

/** Drive an awaited backoff chain without spending wall-clock on it. */
async function drainTimers(t: { mock: { timers: { tick(ms: number): void } } }, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(60_000);
  }
}

test('runPost — batch throws AFTER the write landed: reconciliation finds the comments, no fallback, no duplicates', async () => {
  const fake = statefulFake({ batch: { kind: 'throwAfterWriting' } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(result.posted, 3, 'a lost response is not a failed write');
  assert.equal(result.errors.length, 0, 'the incident reported 56 errors for 56 live comments');
  assert.equal(result.attempted, 3);
  assert.equal(result.verified, true);
  assert.equal(fake.singles.length, 0, 'the per-comment fallback must not run');
  assert.equal(fake.server.length, 3);
  assertNoDuplicateComments(fake);
});

test('runPost — batch throws having written NOTHING: fallback still runs (the good path is not regressed)', async () => {
  const fake = statefulFake({ batch: { kind: 'throwWithoutWriting' } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.singles.length, 3, 'all three re-attempted per-comment');
  assert.equal(result.posted, 3);
  assert.equal(result.attempted, 3, 'a failed batch attempt must not inflate attempted');
  assert.equal(result.errors.length, 0);
  assertNoDuplicateComments(fake);
});

test('runPost — batch partially landed: only the missing findings are re-posted', async () => {
  const fake = statefulFake({ batch: { kind: 'throwAfterWriting', only: [0, 1] } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.singles.length, 1, 'only the one that did not land');
  assert.equal(fake.singles[0].body, 'body 2');
  assert.equal(result.posted, 3);
  assert.equal(result.errors.length, 0);
  assert.equal(fake.server.length, 3, 'the two that landed were not written again');
  assertNoDuplicateComments(fake);
});

test('runPost — the write landed AND the read-back fails: the batch is NOT re-issued', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // The compound failure the reviewers found: a 504 that committed, plus a read
  // that fails because it is the same outage. With an empty map standing in for
  // "nothing landed", the transient 504 retried the whole batch and then fell
  // through to per-comment — 3 findings became 15 live comments, reported as
  // `posted 3 / errors 0`. An unverifiable outcome must stop the run, not
  // restart the write.
  const fake = statefulFake({ batch: { kind: 'throwAfterWriting' }, readThrows: true, transient: true });
  const pending = runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });
  await drainTimers(t);
  const result = await pending;

  assert.equal(fake.batchCalls, 1, 'no blind retry when the outcome is unknown');
  assert.equal(fake.singles.length, 0, 'no blind fallback either');
  assert.equal(fake.server.length, 3, 'exactly what the first write left');
  assert.equal(result.verified, false, 'and the run says so');
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0].error, /could not verify/);
  assertNoDuplicateComments(fake);
});

test('runPost — an unverifiable batch failure is reported, never re-issued blind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Replaces the old "a failing read never turns into a failed post": falling
  // back on an unreadable PR is exactly the duplicate this module prevents.
  const fake = statefulFake({ batch: { kind: 'throwWithoutWriting' }, readThrows: true });
  const pending = runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });
  await drainTimers(t);
  const result = await pending;

  assert.equal(fake.singles.length, 0);
  assert.equal(result.posted, 0);
  assert.equal(result.verified, false);
  assert.equal(result.errors.length, 3);
  assertNoDuplicateComments(fake);
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
  assertNoDuplicateComments(fake);
});

test('runPost — reconciliation promotes ONLY the errors whose comments are on the PR', async () => {
  const fake = statefulFake({ batch: { kind: 'throwWithoutWriting' } });
  const inner = fake.provider.postLineComment;
  let n = 0;
  fake.provider.postLineComment = async (ref, f, sha) => {
    // First two land then report failure; the third genuinely never lands.
    if (n++ < 2) await inner(ref, f, sha);
    throw new Error('422 Validation Failed');
  };
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(result.posted, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].finding.body, 'body 2', 'the identity, not just the count');
  assertNoDuplicateComments(fake);
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

test('runPost — a comment that predates this run is not mistaken for one we just wrote', async () => {
  // The mirror image of the incident: claiming a pre-existing comment reports a
  // finding as posted that was never written, and if that fills the count
  // posted.marker locks --resume out of recovering it.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const fake = statefulFake({
    batch: { kind: 'throwWithoutWriting' },
    seed: [old('src/a.ts', 11, 'body 0', twoHoursAgo)],
  });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.singles.length, 3, 'all three genuinely re-posted, not two');
  assert.equal(result.posted, 3);
  assert.equal(result.errors.length, 0);
});

test('runPost — a comment with an unparseable createdAt counts as landed (verification must not go blind)', async () => {
  const fake = statefulFake({
    batch: { kind: 'throwWithoutWriting' },
    seed: [old('src/a.ts', 11, 'body 0', '')],
  });
  const result = await runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  assert.equal(fake.singles.length, 2, 'the one with an untimed match is treated as already there');
  assert.equal(result.posted, 3);
});

test('runPost — two findings sharing a body in different files each need their own comment', async () => {
  // dedupeWithinBatch never folds across files, so byte-identical bodies reach
  // the poster. A body-only key hands the wrong finding the wrong comment:
  // one is silently lost and the other duplicated.
  const shared = 'the same rule, flagged twice';
  const input: Finding[] = [
    { severity: 'MEDIUM', title: 't', body: shared, file: 'src/a.ts', line: 11 },
    { severity: 'MEDIUM', title: 't', body: shared, file: 'src/b.ts', line: 40 },
  ];
  // Only the SECOND one lands, so a body-only match would credit the first.
  const fake = statefulFake({ batch: { kind: 'throwAfterWriting', only: [1] } });
  const result = await runPost({ prUrl: 'u', outputs: wrap(input), publish: true, provider: fake.provider });

  assert.equal(fake.singles.length, 1);
  assert.equal(fake.singles[0].file, 'src/a.ts', 'the one that is genuinely absent');
  assert.equal(result.posted, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(fake.server.length, 2);
  assertNoDuplicateComments(fake);
});

test('runPost — a transient batch error that landed nothing is retried as a batch, not degraded to per-comment', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = statefulFake({ batch: { kind: 'failThenSucceed' }, transient: true });
  const pending = runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });
  await drainTimers(t);
  const result = await pending;

  assert.equal(fake.batchCalls, 2);
  assert.equal(result.posted, 3);
  assert.equal(fake.singles.length, 0);
  assert.equal(fake.server.length, 3);
  assertNoDuplicateComments(fake);
});

test('runPost — a transient error that never clears stops retrying and falls back', async (t) => {
  // The retry loop's only terminating condition is the attempt bound, and
  // nothing else exercises exhaustion: a regression there turns a flapping 5xx
  // into a run that never returns. Timers are mocked so this costs no wall time.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = statefulFake({ batch: { kind: 'alwaysTransient' }, transient: true });
  const pending = runPost({ prUrl: 'u', outputs: wrap(inlineFindings()), publish: true, gather: gatherFixture(), provider: fake.provider });

  await drainTimers(t);
  const result = await pending;

  assert.equal(fake.batchCalls, 4, 'one attempt plus RETRY_BACKOFF_MS.length retries, then stop');
  assert.equal(fake.singles.length, 3, 'and the leftovers go per-comment');
  assert.equal(result.posted, 3);
  assertNoDuplicateComments(fake);
});
