import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { countChangedLines, diffLines } from '../src/util/diff-lines.js';

test('countChangedLines — hunks-only patch (GitHub/GitLab shape): hunk headers skipped, content counted', () => {
  assert.deepEqual(countChangedLines('@@ -1,2 +1,3 @@\n a\n-b\n+c\n+d'), { additions: 2, deletions: 1 });
});

test('countChangedLines — ADO synthesized shape: the ---/+++ preamble is not content, but a `++counter;` line inside is', () => {
  const patch = '--- a/x.ts (base)\n+++ b/x.ts (head)\n@@ -1,1 +1,2 @@\n x\n+++counter;';
  assert.deepEqual(countChangedLines(patch), { additions: 1, deletions: 0 });
  assert.deepEqual([...diffLines(patch)], ['@@ -1,1 +1,2 @@', ' x', '+++counter;']);
});

test('countChangedLines — empty patch counts nothing', () => {
  assert.deepEqual(countChangedLines(''), { additions: 0, deletions: 0 });
});
