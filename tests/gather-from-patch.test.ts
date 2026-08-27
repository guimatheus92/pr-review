import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gatherFromPatch } from '../scripts/gather-from-patch.mjs';

test('gatherFromPatch — classifies added, modified, deleted, and renamed files', () => {
  const patch = [
    'diff --git a/src/old.ts b/src/old.ts',
    '--- a/src/old.ts',
    '+++ b/src/old.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    'deleted file mode 100644',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/src/before.ts b/src/after.ts',
    'similarity index 90%',
    'rename from src/before.ts',
    'rename to src/after.ts',
    '--- a/src/before.ts',
    '+++ b/src/after.ts',
    '@@ -1 +1 @@',
    '-before',
    '+after',
  ].join('\n');
  const gather = gatherFromPatch(patch);
  assert.deepEqual(
    gather.changedFiles.map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions })),
    [
      { path: 'src/old.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
      { path: 'src/deleted.ts', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'src/after.ts', status: 'renamed', additions: 1, deletions: 1 },
    ],
  );
  assert.equal(gather.changedFiles[3].previousPath, 'src/before.ts');
});

test('gatherFromPatch — parses Git C-quoted paths with spaces and octal escapes', () => {
  const patch = [
    'diff --git "a/src/foo\\040bar.ts" "b/src/foo\\040bar.ts"',
    '--- "a/src/foo bar.ts"',
    '+++ "b/src/foo bar.ts"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const gather = gatherFromPatch(patch);
  assert.equal(gather.changedFiles[0].path, 'src/foo bar.ts');
  assert.equal(gather.changedFiles[0].previousPath, undefined);
});

test('gatherFromPatch — rejects control characters decoded from quoted paths', () => {
  const patch = 'diff --git "a/safe\\012name.ts" "b/safe\\012name.ts"\n@@ -0,0 +1 @@\n+x';
  assert.throws(() => gatherFromPatch(patch), /control characters/);
});