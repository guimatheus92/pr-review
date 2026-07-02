import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildValidLinesMap, snapLineToDiff, validLinesFromPatch } from '../src/dispatch/line-snap.js';
import type { ChangedFile } from '../src/types.js';

const PATCH = [
  '@@ -10,4 +10,5 @@',
  ' context line 10',
  '-removed old 11',
  '+added new 11',
  '+added new 12',
  ' context line 13',
  '\\ No newline at end of file',
].join('\n');

test('validLinesFromPatch — added and context lines only', () => {
  const valid = validLinesFromPatch(PATCH);
  assert.deepEqual([...valid].sort((a, b) => a - b), [10, 11, 12, 13]);
});

test('snapLineToDiff — exact hit, nearest snap, and missing file', () => {
  const files: ChangedFile[] = [
    { path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH },
    { path: 'src/excluded.ts', status: 'modified', additions: 1, deletions: 0, patch: PATCH, excluded: true },
  ];
  const map = buildValidLinesMap(files);
  assert.equal(snapLineToDiff(map, 'src/a.ts', 11), 11);
  assert.equal(snapLineToDiff(map, 'src/a.ts', 15), 13);
  assert.equal(snapLineToDiff(map, 'src/a.ts', 1), 10);
  assert.equal(snapLineToDiff(map, 'src/not-in-diff.ts', 5), null);
  assert.equal(snapLineToDiff(map, 'src/excluded.ts', 11), null);
});

test('snapLineToDiff — equidistant tie-break keeps the LOWER valid line', () => {
  const map = new Map([['f.ts', new Set([10, 12])]]);
  assert.equal(snapLineToDiff(map, 'f.ts', 11), 10);
});
