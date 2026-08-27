import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { refreshCachedGatherIdentity, runGather } from '../src/commands/gather.js';
import type { GatherOutput, PrRef } from '../src/types.js';
import type { PrProvider } from '../src/providers/types.js';

test('refreshCachedGatherIdentity — authoritative ADO project upgrades a stale cached payload', () => {
  const stale = {
    pr: {
      provider: 'azuredevops', url: 'https://dev.azure.com/org/_git/repo/pullrequest/9',
      owner: 'org', organization: 'org', repo: 'repo', number: 9,
    },
    metadata: {}, changedFiles: [], fullDiff: '', existingComments: [], gatheredAt: '',
  } as unknown as GatherOutput;
  const current = {
    ...stale.pr,
    project: 'ProjectA',
    baseUrl: 'https://dev.azure.com/org',
  };

  const refreshed = refreshCachedGatherIdentity(stale, current);
  assert.equal(refreshed.pr.project, 'ProjectA');
  assert.equal(refreshed.pr.baseUrl, 'https://dev.azure.com/org');
  assert.equal(stale.pr.project, undefined, 'cache data is not mutated in place');
});

test('runGather — unresolved ADO project bypasses stale cache reads and fresh cache writes', async () => {
  const nonce = `unresolved-${process.pid}-${Date.now()}`;
  const ref: PrRef = {
    provider: 'azuredevops', url: `https://dev.azure.com/${nonce}/_git/repo/pullrequest/9`,
    owner: nonce, organization: nonce, repo: 'repo', number: 9,
  };
  const metadata = {
    title: 't', description: 'description', author: 'a', headSha: 'abcdef1234567890', baseSha: 'base',
    baseBranch: 'main', headBranch: 'feature', labels: [], linkedItems: [], createdAt: '', updatedAt: '',
    isDraft: false, state: 'open' as const,
  };
  let changedFileReads = 0;
  let cacheReads = 0;
  let cacheWrites = 0;
  const provider: PrProvider = {
    name: 'azuredevops', authEnv: () => ({}), parseUrl: () => ({ ...ref }),
    fetchMetadata: async () => metadata,
    fetchChangedFiles: async () => {
      changedFileReads++;
      return [{ path: 'fresh.ts', status: 'modified', additions: 1, deletions: 0 }];
    },
    fetchFullDiff: async () => 'fresh', fetchExistingComments: async () => [],
    postLineComment: async () => null, isTransientError: () => false,
  };
  const result = await runGather({
    prUrl: ref.url,
    provider,
    readGatherCacheFn: () => {
      cacheReads++;
      throw new Error('unresolved ADO cache must not be read');
    },
    writeGatherCacheFn: () => {
      cacheWrites++;
      throw new Error('unresolved ADO cache must not be written');
    },
  });
  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 0);
  assert.equal(changedFileReads, 1);
  assert.deepEqual(result.changedFiles.map((file) => file.path), ['fresh.ts']);
});

test('runGather — filtered legacy cache is bypassed and replaced with raw provider data', async () => {
  const ref: PrRef = { provider: 'github', url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 };
  const metadata = {
    title: 't', description: 'description', author: 'a', headSha: 'abcdef1234567890', baseSha: 'base',
    baseBranch: 'main', headBranch: 'feature', labels: [], linkedItems: [], createdAt: '', updatedAt: '',
    isDraft: false, state: 'open' as const,
  };
  const legacy = {
    pr: ref, metadata,
    changedFiles: [
      { path: '.pr-review.yaml', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@\n+x' },
      { path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, excluded: true, excludedReason: 'old' },
    ],
    fullDiff: 'old', existingComments: [], gatheredAt: '',
  };
  let fetches = 0;
  let cached: GatherOutput | undefined;
  const provider: PrProvider = {
    name: 'github', authEnv: () => ({}), parseUrl: () => ({ ...ref, baseUrl: 'https://api.github.com' }),
    fetchMetadata: async () => metadata,
    fetchChangedFiles: async () => {
      fetches++;
      return [
        { path: '.pr-review.yaml', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+x' },
        { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+fresh' },
      ];
    },
    fetchFullDiff: async () => 'fresh', fetchExistingComments: async () => [],
    postLineComment: async () => null, isTransientError: () => false,
  };
  const result = await runGather({
    prUrl: ref.url,
    provider,
    readGatherCacheFn: () => ({ data: legacy, path: 'legacy.json', ageMs: 1 }),
    writeGatherCacheFn: (value) => (cached = value, 'new.json'),
  });
  assert.equal(fetches, 1);
  assert.equal(result.changedFiles.find((file) => file.path === 'src/app.ts')?.patch, '@@\n+fresh');
  assert.equal(cached?.changedFiles.some((file) => file.excluded), false);
  assert.equal(cached?.changedFiles.find((file) => file.path === 'src/app.ts')?.patch, '@@\n+fresh');
});