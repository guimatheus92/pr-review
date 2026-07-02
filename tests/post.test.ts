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
