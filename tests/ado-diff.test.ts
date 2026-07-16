import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyChange, lcsLineDiff, synthesizePatch } from '../src/providers/azuredevops.js';
import { validLinesFromPatch } from '../src/dispatch/line-snap.js';

test('lcsLineDiff — prefix/suffix trim stitches context back at correct offsets', () => {
  const base = ['a', 'b', 'c', 'd', 'e'];
  const head = ['a', 'b', 'X', 'd', 'e'];
  const diff = lcsLineDiff(base, head);
  // replacement emits the added line before the deleted one (backtrack order);
  // both orders are valid unified diffs and NEW-side numbering is unaffected
  assert.deepEqual(diff.split('\n'), [' a', ' b', '+X', '-c', ' d', ' e']);
});

test('lcsLineDiff — insertion and deletion keep surrounding context aligned', () => {
  assert.deepEqual(lcsLineDiff(['a', 'b'], ['a', 'new', 'b']).split('\n'), [' a', '+new', ' b']);
  assert.deepEqual(lcsLineDiff(['a', 'gone', 'b'], ['a', 'b']).split('\n'), [' a', '-gone', ' b']);
});

test('synthesizePatch → validLinesFromPatch roundtrip — NEW-side line numbers land where the head file has them', () => {
  const base = ['l1', 'l2', 'l3', 'l4'].join('\n');
  const head = ['l1', 'l2-changed', 'l3', 'l4', 'l5-added'].join('\n');
  const patch = synthesizePatch('f.ts', base, head, 'basesha', 'headsha');
  const valid = validLinesFromPatch(patch);
  // head has 5 lines; every context/added line must be addressable at its head offset
  assert.deepEqual([...valid].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test('synthesizePatch — added and deleted files', () => {
  const added = synthesizePatch('f.ts', null, 'x\ny', '', 'headsha');
  assert.ok(added.startsWith('--- /dev/null'));
  assert.deepEqual(validLinesFromPatch(added).size, 2);
  const deleted = synthesizePatch('f.ts', 'x\ny', null, 'basesha', 'headsha');
  assert.ok(deleted.includes('+++ /dev/null'));
  assert.equal(validLinesFromPatch(deleted).size, 0);
});

test('classifyChange — add/edit/delete map by bit, base path is the new path', () => {
  assert.deepEqual(classifyChange(1, 'new/a.ts', undefined), { status: 'added', basePath: 'new/a.ts' });
  assert.deepEqual(classifyChange(2, 'a.ts', undefined), { status: 'modified', basePath: 'a.ts' });
  assert.deepEqual(classifyChange(16, 'a.ts', undefined), { status: 'deleted', basePath: 'a.ts' });
  // undefined/None → modified, so a base fetch still happens rather than being skipped as "added".
  assert.deepEqual(classifyChange(undefined, 'a.ts', undefined), { status: 'modified', basePath: 'a.ts' });
});

test('classifyChange — a pure rename fetches base from the OLD (source) path', () => {
  const { status, basePath } = classifyChange(8, 'new/name.tmdl', '/old/name.tmdl');
  assert.equal(status, 'modified');
  assert.equal(basePath, 'old/name.tmdl'); // leading slash stripped; base read from the pre-rename path
});

test('classifyChange — rename OR-ed with edit (10) is still a rename, not a plain modify', () => {
  const { status, basePath } = classifyChange(10, 'new/name.tmdl', '/old/name.tmdl');
  assert.equal(status, 'modified');
  assert.equal(basePath, 'old/name.tmdl');
});

test('classifyChange — rename bit with a missing sourceServerItem falls back to the new path', () => {
  assert.deepEqual(classifyChange(8, 'a.ts', undefined), { status: 'modified', basePath: 'a.ts' });
});

test('lcsLineDiff — caps the DP matrix on huge inputs (coarse replace, no OOM, new-side lines intact)', () => {
  // No shared prefix/suffix → the full core would be a ~3.6×10^7-cell matrix,
  // over the cap; it must fall back to a coarse replace without allocating it.
  const a = Array.from({ length: 6000 }, (_, i) => `a-line-${i}`);
  const b = Array.from({ length: 6000 }, (_, i) => `b-line-${i}`);
  const diff = lcsLineDiff(a, b).split('\n');
  assert.equal(diff.filter((l) => l.startsWith('-')).length, 6000);
  assert.equal(diff.filter((l) => l.startsWith('+')).length, 6000);
  assert.ok(!diff.some((l) => l.startsWith(' ')), 'no shared context when prefix/suffix are empty');
  // NEW-side line numbers must remain fully addressable for line-snapping.
  const patch = synthesizePatch('big.tmdl', a.join('\n'), b.join('\n'), 'base', 'head');
  assert.equal(validLinesFromPatch(patch).size, 6000);
});
