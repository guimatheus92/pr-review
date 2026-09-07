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

test('fetchChangedFiles — a rename carries previousPath, including when the rename bit is OR-ed with add or delete', async () => {
  // ADO reported every rename as a plain modify and never set previousPath, so
  // gatherChangesRepoConfig — which checks the PREVIOUS path too — could not see a
  // .pr-review.yaml renamed away on ADO alone. previousPath is keyed on the source
  // path rather than on the `renamed` label, because delete and add keep precedence
  // over the rename bit: ADD|RENAME (9) is labelled `added` and is still a rename.
  const RENAME = 8;
  const ADD = 1;
  const { provider, ref, items } = stubbedProvider(() => ({
    changeEntries: [
      { changeType: RENAME, item: { path: '/moved.ts' }, sourceServerItem: '/original.ts' },
      { changeType: RENAME | 2, item: { path: '/edited-and-moved.ts' }, sourceServerItem: '/was-here.ts' },
      { changeType: ADD | RENAME, item: { path: '/added-and-moved.ts' }, sourceServerItem: '/came-from.ts' },
      { changeType: DELETED | RENAME, item: { path: '/gone.ts' }, sourceServerItem: '/used-to-be.ts' },
      { changeType: RENAME, item: { path: '/no-source.ts' } },
      { changeType: 2, item: { path: '/plain.ts' } },
    ],
  }));
  const files = await provider.fetchChangedFiles(ref);
  const by = (path: string) => files.find((f) => f.path === path)!;

  assert.equal(by('moved.ts').status, 'renamed');
  assert.equal(by('moved.ts').previousPath, 'original.ts');
  assert.equal(by('edited-and-moved.ts').status, 'renamed');
  assert.equal(by('edited-and-moved.ts').previousPath, 'was-here.ts');

  // Labels stay add/delete so the content fetches guarded by `status !== 'added'`
  // / `!== 'deleted'` are unchanged — but the trust gate still gets the old path.
  assert.equal(by('added-and-moved.ts').status, 'added');
  assert.equal(by('added-and-moved.ts').previousPath, 'came-from.ts');
  assert.equal(by('gone.ts').status, 'deleted');
  assert.equal(by('gone.ts').previousPath, 'used-to-be.ts');

  // No source path to report, so not a rename we can describe: labelled `modified`
  // exactly as before renames were labelled at all, and no previousPath.
  assert.equal(by('no-source.ts').status, 'modified');
  assert.equal(by('no-source.ts').previousPath, undefined);
  assert.equal(by('plain.ts').previousPath, undefined);

  // The PR's central safety claim, asserted rather than commented: labelling a
  // rename does not re-route a single content fetch. Head is read at the new path,
  // base at the old one — the routing `classifyChange` already produced through
  // basePath, unchanged by the new label. An added file reads no base, a deleted
  // file reads nothing at all.
  assert.deepEqual(items.sort(), [
    '/added-and-moved.ts', // head only: status `added` still skips the base read
    '/edited-and-moved.ts',
    '/was-here.ts', // its base, read at the OLD path
    '/moved.ts',
    '/original.ts', // its base, read at the OLD path
    '/no-source.ts',
    '/no-source.ts', // head + base, both at the new path
    '/plain.ts',
    '/plain.ts',
  ].sort());
  assert.equal(items.includes('/gone.ts'), false, 'a deleted file fetches no content at all');
  assert.equal(items.includes('/used-to-be.ts'), false, 'nor does its source path');
});

test('fetchExistingComments — a tombstoned comment is not an existing comment', async () => {
  // Azure DevOps never removes a deleted comment; it leaves the entry in the
  // thread with isDeleted: true and empty content. A live fixture PR reviewed a
  // few times carried 183 tombstones against 2 real comments, and counting them
  // made `pr-review verify` report 63 inline comments matching no planned
  // finding (INV-POST-06, "a dispatched agent wrote to the PR") and 14
  // duplicated locations (INV-POST-05). Both alarms were false. They also
  // reached every review pass as prior PR discussion.
  const provider = new AzureDevOpsProvider();
  const ref = provider.parseUrl(PR_URL)!;
  const thread = (id: number, comments: unknown[]) => ({
    id,
    threadContext: { filePath: '/src/a.cs', rightFileStart: { line: 7 } },
    comments,
  });
  const git = {
    getPullRequestById: async () => PR,
    getThreads: async () => [
      thread(1, [
        { id: 1, content: 'still here', author: { displayName: 'Reviewer' }, publishedDate: new Date(0) },
        { id: 2, content: '', isDeleted: true, author: { displayName: 'Reviewer' }, publishedDate: new Date(0) },
      ]),
      // A wholly deleted thread contributes nothing at all.
      thread(2, [{ id: 3, content: '', isDeleted: true, author: { displayName: 'Reviewer' }, publishedDate: new Date(0) }]),
    ],
  };
  (provider as unknown as { gitApis: Map<string, Promise<unknown>> }).gitApis.set(orgUrlFor(ref), Promise.resolve(git));

  const comments = await provider.fetchExistingComments(ref);
  assert.deepEqual(comments.map((c) => c.body), ['still here']);
  assert.equal(comments.length, 1, 'two tombstones must not become two existing comments');
});

// ---------------------------------------------------------------------------
// INV-FETCH-04 — content is fetched only for files that can still reach a pass.
//
// ADO is the provider where this is expensive: GitHub and GitLab hand over the
// patch inside the file listing, ADO synthesizes it from TWO getItem calls per
// modified file, each downloading the whole file at one revision. The path list
// is unaffected in every case below — it is what the trust gates read.

const edited = (path: string) => ({ changeType: 2, item: { path } });

test('fetchChangedFiles — above the file guard nothing is fetched: the list is paths, the review is refused anyway', async () => {
  const entries = Array.from({ length: 501 }, (_, i) => edited(`/src/f${i}.cs`));
  const { provider, ref, items } = stubbedProvider(() => ({ changeEntries: entries, nextSkip: 0 }));
  const files = await provider.fetchChangedFiles(ref, { maxPatchedFiles: 500 });
  assert.equal(items.length, 0, '501 in-scope files trips the guard: not one getItem is worth making');
  assert.equal(files.length, 501, 'the PATH list stays complete — it feeds the trust gates (INV-FETCH-01)');
  assert.deepEqual(files.slice(0, 2).map((f) => f.path), ['src/f0.cs', 'src/f1.cs']);
  assert.ok(files.every((f) => f.patch === undefined), 'no patch was synthesized');
});

test('fetchChangedFiles — at the guard exactly, every in-scope file is still fetched', async () => {
  // 500 is allowed (the gate is `>`), so the cheap path must not swallow a PR
  // the review would have accepted. Two getItem per modified file.
  const entries = Array.from({ length: 500 }, (_, i) => edited(`/src/f${i}.cs`));
  const { provider, ref, items } = stubbedProvider(() => ({ changeEntries: entries, nextSkip: 0 }));
  const files = await provider.fetchChangedFiles(ref, { maxPatchedFiles: 500 });
  assert.equal(items.length, 1000, 'head + base for each of the 500');
  assert.ok(files.every((f) => f.patch !== undefined));
});

test('fetchChangedFiles — an excluded path is listed but never fetched: its patch is discarded seconds later anyway', async () => {
  const { provider, ref, items } = stubbedProvider(() => ({
    changeEntries: [edited('/src/a.cs'), edited('/package-lock.json'), edited('/assets/logo.png'), edited('/vendor/dep.cs')],
    nextSkip: 0,
  }));
  const files = await provider.fetchChangedFiles(ref, {
    excludes: ['**/package-lock.json', '**/vendor/**', '**/*.{png,jpg}'],
    maxPatchedFiles: 500,
  });
  assert.deepEqual(items, ['/src/a.cs', '/src/a.cs'], 'only the reviewable file costs a fetch (head + base)');
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/a.cs', 'package-lock.json', 'assets/logo.png', 'vendor/dep.cs'],
    'every path is still listed: applyDiffExclusions marks them, gather counts them, trust reads them',
  );
  assert.equal(files.find((f) => f.path === 'package-lock.json')?.patch, undefined);
});

test('fetchChangedFiles — the guard counts in-scope files only, so exclusions can keep a PR reviewable', async () => {
  // 501 rows, one excluded → 500 in scope → under the guard → the 500 are fetched.
  const entries = [...Array.from({ length: 500 }, (_, i) => edited(`/src/f${i}.cs`)), edited('/package-lock.json')];
  const { provider, ref, items } = stubbedProvider(() => ({ changeEntries: entries, nextSkip: 0 }));
  const files = await provider.fetchChangedFiles(ref, { excludes: ['**/package-lock.json'], maxPatchedFiles: 500 });
  assert.equal(items.length, 1000, 'the lockfile is not in scope, so the PR is not over the guard');
  assert.equal(files.length, 501);
});

test('fetchChangedFiles — with no options every file is fetched: the standalone gather command is unchanged', async () => {
  const { provider, ref, items } = stubbedProvider(() => ({ changeEntries: [edited('/src/a.cs')], nextSkip: 0 }));
  await provider.fetchChangedFiles(ref);
  assert.deepEqual(items, ['/src/a.cs', '/src/a.cs']);
});
