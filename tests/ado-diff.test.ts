import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyChange, lcsLineDiff, synthesizePatch, toHunks } from '../src/providers/azuredevops.js';
import { validLinesFromPatch } from '../src/dispatch/line-snap.js';
import { countChangedLines } from '../src/util/diff-lines.js';

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

test('classifyChange — a pure rename is "renamed" and fetches base from the OLD (source) path', () => {
  const { status, basePath } = classifyChange(8, 'new/name.tmdl', '/old/name.tmdl');
  assert.equal(status, 'renamed');
  assert.equal(basePath, 'old/name.tmdl'); // leading slash stripped; base read from the pre-rename path
});

test('classifyChange — rename OR-ed with edit (10) is still a rename, not a plain modify', () => {
  const { status, basePath } = classifyChange(10, 'new/name.tmdl', '/old/name.tmdl');
  assert.equal(status, 'renamed');
  assert.equal(basePath, 'old/name.tmdl');
});

test('classifyChange — the rename bit without a sourceServerItem is not a rename we can describe', () => {
  // `renamed` must never mean less here than on GitHub and GitLab, where it always
  // pairs with a previousPath. With no source item there is no previous path to
  // report, so this stays `modified` — which is also what it was before renames
  // were labelled at all, so the base fetch is unchanged.
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

// ---------------------------------------------------------------------------
// Hunks. Azure DevOps has no diff endpoint, so the patch is built here from two
// whole file bodies — and it used to be EMITTED whole too, every unchanged line
// carried as context. Every downstream size then scaled with the size of the
// files instead of the size of the change.
//
// The danger in framing it properly is the line numbers: a wrong `@@` header is
// silent, and it lands every finding in the file on the wrong line. So the
// roundtrip below is checked by CONTENT, not by counting.

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);

/** Every addressable NEW-side line, mapped to the text the patch places there. */
function newSideText(patch: string): Map<number, string> {
  const out = new Map<number, string>();
  let newLine = 0;
  for (const ln of patch.split('\n')) {
    const header = /^@@ -\d+,\d+ \+(\d+),\d+ @@/.exec(ln);
    if (header) {
      newLine = parseInt(header[1]!, 10) - 1;
      continue;
    }
    if (ln.startsWith('---') || ln.startsWith('+++')) continue;
    if (ln.startsWith('-')) continue;
    if (ln.startsWith('+') || ln.startsWith(' ')) out.set(++newLine, ln.slice(1));
  }
  return out;
}

test('toHunks — one change in a long file yields one small hunk, not the whole file', () => {
  const base = lines(100);
  const head = [...base];
  head[49] = 'CHANGED';
  const patch = synthesizePatch('f.ts', base.join('\n'), head.join('\n'), 'basesha', 'headsha');
  const hunks = patch.split('\n').filter((l) => l.startsWith('@@'));
  assert.equal(hunks.length, 1, 'one localized edit is one hunk');
  assert.equal(hunks[0], '@@ -47,7 +47,7 @@', '3 lines of context either side, git\'s own default');
  assert.ok(patch.split('\n').length < 15, `the patch is the change, not the file (got ${patch.split('\n').length} lines)`);
  assert.deepEqual(
    [...validLinesFromPatch(patch)].sort((a, b) => a - b),
    [47, 48, 49, 50, 51, 52, 53],
    'only lines inside the hunk are addressable — the same rule GitHub and GitLab post by',
  );
});

test('toHunks — every addressable line still carries the text the HEAD file has there', () => {
  // The assertion that would catch a wrong @@ offset. Counting lines cannot: a
  // header off by one produces exactly as many valid lines as a correct one.
  const base = lines(60);
  const head = [...base];
  head[9] = 'EDIT-A';
  head.splice(30, 0, 'INSERTED-1', 'INSERTED-2');
  head[54] = 'EDIT-B';
  const patch = synthesizePatch('f.ts', base.join('\n'), head.join('\n'), 'basesha', 'headsha');
  for (const [lineNumber, text] of newSideText(patch)) {
    assert.equal(text, head[lineNumber - 1], `line ${lineNumber} of the patch must be line ${lineNumber} of the head file`);
  }
  assert.ok(newSideText(patch).size > 0);
});

test('toHunks — distant changes become separate hunks; touching ones are merged', () => {
  const base = lines(60);
  const far = [...base];
  far[4] = 'A';
  far[54] = 'B';
  const farPatch = synthesizePatch('f.ts', base.join('\n'), far.join('\n'), 'b', 'h');
  assert.equal(farPatch.split('\n').filter((l) => l.startsWith('@@')).length, 2);

  const near = [...base];
  near[29] = 'A';
  near[32] = 'B'; // 3 apart: the context windows overlap
  const nearPatch = synthesizePatch('f.ts', base.join('\n'), near.join('\n'), 'b', 'h');
  assert.equal(
    nearPatch.split('\n').filter((l) => l.startsWith('@@')).length,
    1,
    'overlapping context is one hunk — two would repeat the same lines on both sides',
  );
});

test('toHunks — a created file is -0,0 and a deleted one is +0,0, the way git writes them', () => {
  const added = synthesizePatch('f.ts', null, 'x\ny\nz', '', 'headsha');
  assert.equal(added.split('\n')[2], '@@ -0,0 +1,3 @@');
  assert.deepEqual([...validLinesFromPatch(added)], [1, 2, 3]);
  const deleted = synthesizePatch('f.ts', 'x\ny\nz', null, 'basesha', 'headsha');
  assert.equal(deleted.split('\n')[2], '@@ -1,3 +0,0 @@');
  assert.equal(validLinesFromPatch(deleted).size, 0, 'a deleted file has no addressable NEW-side line');
});

test('toHunks — identical content is no patch at all, not a preamble with nothing under it', () => {
  // ADO lists encoding- and mode-only changes as changed files. A truthy string
  // with no hunks is what INV-FETCH-02 would count as "carries a patch".
  assert.equal(synthesizePatch('f.ts', 'same\n', 'same\n', 'b', 'h'), '');
  assert.equal(toHunks([' a', ' b']), '');
});

test('toHunks — additions and deletions are counted from the hunks, not from whole-file context', () => {
  const base = lines(50);
  const head = [...base];
  head[24] = 'CHANGED';
  const patch = synthesizePatch('f.ts', base.join('\n'), head.join('\n'), 'b', 'h');
  assert.deepEqual(countChangedLines(patch), { additions: 1, deletions: 1 });
});

test('toHunks — the coarse MAX_LCS_CELLS fallback is framed too, and keeps its NEW-side numbering', () => {
  // A rewritten core big enough to skip the DP matrix (a real OOM once came from
  // a renamed PBIR file). It emits the whole core removed then added; the
  // framing must not treat that as a reason to fall back to the whole file.
  const base = [...lines(5, 'ctx'), ...lines(4000, 'old'), ...lines(5, 'tail')];
  const head = [...lines(5, 'ctx'), ...lines(4000, 'new'), ...lines(5, 'tail')];
  const patch = synthesizePatch('f.ts', base.join('\n'), head.join('\n'), 'b', 'h');
  assert.ok(patch.includes('@@ -3,'), 'context before the rewritten core is trimmed to 3 lines');
  for (const [lineNumber, text] of newSideText(patch)) {
    assert.equal(text, head[lineNumber - 1], `line ${lineNumber} must match the head file`);
  }
});
