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
