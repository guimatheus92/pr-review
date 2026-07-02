import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { lcsLineDiff, synthesizePatch } from '../src/providers/azuredevops.js';
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
