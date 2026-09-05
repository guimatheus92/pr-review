import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AzureDevOpsProvider, orgUrlFor } from '../../src/providers/azuredevops.js';

// Iteration changes are a paged endpoint: $top defaults to 100 (max 2000) and the
// response carries nextSkip. 0.6–0.10 issued ONE unpaged call, so a PR with more
// than 100 files was silently reviewed on its first 100. The stub below is the
// same gitApi seam tests/parse-url.test.ts uses.
const PR_URL = 'https://dev.azure.com/contoso/Proj/_git/infra-core/pullrequest/9';
const PR = {
  pullRequestId: 9,
  repository: { id: 'repo-id', project: { name: 'Proj' } },
  lastMergeSourceCommit: { commitId: 'head' },
  lastMergeTargetCommit: { commitId: 'base' },
};
const DELETED = 16; // no content fetch needed for a deleted file

type Page = { changeEntries?: unknown[]; nextSkip?: number; nextTop?: number };

function stubbedProvider(
  pages: (skip: number) => Page,
  getItem?: (path: string) => unknown,
): { provider: AzureDevOpsProvider; ref: ReturnType<AzureDevOpsProvider['parseUrl']>; calls: unknown[][]; items: string[] } {
  const provider = new AzureDevOpsProvider();
  const ref = provider.parseUrl(PR_URL)!;
  const calls: unknown[][] = [];
  const items: string[] = [];
  const git = {
    getPullRequestById: async () => PR,
    getPullRequestIterations: async () => [{ id: 1 }, { id: 2 }],
    getPullRequestIterationChanges: async (_repo: string, _id: number, iterationId: number, project: string | undefined, top?: number, skip?: number) => {
      calls.push([iterationId, project, top, skip]);
      if (calls.length > 5) throw new Error('runaway pagination loop');
      return pages(skip ?? 0);
    },
    getItem: async (_repo: string, path: string) => {
      items.push(path);
      return getItem ? getItem(path) : { content: 'x' };
    },
  };
  (provider as unknown as { gitApis: Map<string, Promise<unknown>> }).gitApis.set(orgUrlFor(ref), Promise.resolve(git));
  return { provider, ref, calls, items };
}

const deleted = (path: string) => ({ changeType: DELETED, item: { path } });

test('fetchChangedFiles — pages iteration changes at top=2000 and follows nextSkip to completion', async () => {
  const { provider, ref, calls } = stubbedProvider((skip) =>
    skip === 0
      ? { changeEntries: [deleted('/a.cs'), deleted('/b.cs')], nextSkip: 2000, nextTop: 2000 }
      : { changeEntries: [deleted('/c.cs')], nextSkip: 0, nextTop: 0 },
  );
  const files = await provider.fetchChangedFiles(ref);
  assert.deepEqual(files.map((f) => f.path), ['a.cs', 'b.cs', 'c.cs']);
  assert.deepEqual(calls, [[2, 'Proj', 2000, 0], [2, 'Proj', 2000, 2000]], 'latest iteration, max page size, cursor forwarded');
});

test('fetchChangedFiles — a full page with no cursor is probed once more, not trusted as the end', async () => {
  // Every documented sample response OMITS nextSkip entirely; a server that never
  // sends it on an exactly-full page must not end the list at 2000.
  const full = Array.from({ length: 2000 }, (_, i) => deleted(`/f${i}.cs`));
  const { provider, ref, calls } = stubbedProvider((skip) => (skip === 0 ? { changeEntries: full } : { changeEntries: [] }));
  const files = await provider.fetchChangedFiles(ref);
  assert.equal(files.length, 2000);
  assert.deepEqual(calls.map((c) => c[3]), [0, 2000]);
});

test('fetchChangedFiles — a cursor that does not advance fails loudly instead of looping or truncating', async () => {
  const { provider, ref } = stubbedProvider((skip) =>
    skip === 0 ? { changeEntries: [deleted('/a.cs')], nextSkip: 1 } : { changeEntries: [deleted('/b.cs')], nextSkip: 1 },
  );
  await assert.rejects(() => provider.fetchChangedFiles(ref), /did not advance/);
});

test('fetchChangedFiles — folder entries are not files: dropped before any content fetch', async () => {
  const { provider, ref, items } = stubbedProvider(() => ({
    changeEntries: [
      { changeType: 1, item: { path: '/newdir', isFolder: true } },
      { changeType: 1, item: { path: '/newdir/a.ts' } },
      { changeType: 2, item: { path: '/src', isFolder: true } },
      { changeType: 1, item: { path: '/treeonly', gitObjectType: 'tree' } }, // some responses carry only the object type
    ],
    nextSkip: 0,
  }));
  const files = await provider.fetchChangedFiles(ref);
  assert.deepEqual(files.map((f) => f.path), ['newdir/a.ts']);
  assert.deepEqual(items, ['/newdir/a.ts'], 'getItem is asked for the one file and never for a folder');
});

test('fetchChangedFiles — a PR with no iterations is an error, never an empty (and therefore "complete") file list', async () => {
  const provider = new AzureDevOpsProvider();
  const ref = provider.parseUrl(PR_URL)!;
  const git = {
    getPullRequestById: async () => PR,
    getPullRequestIterations: async () => [],
    getPullRequestIterationChanges: async () => { throw new Error('must not be called'); },
  };
  (provider as unknown as { gitApis: Map<string, Promise<unknown>> }).gitApis.set(orgUrlFor(ref), Promise.resolve(git));
  await assert.rejects(() => provider.fetchChangedFiles(ref), /no iterations/);
});
