import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { dedupeAgainstExisting, dedupeWithinBatch } from '../src/dedupe.js';
import type { ExistingComment, Finding } from '../src/types.js';

function mkFinding(over: Partial<Finding>): Finding {
  return {
    severity: 'HIGH',
    title: 'placeholder',
    body: 'placeholder body',
    ...over,
  };
}
function mkComment(over: Partial<ExistingComment>): ExistingComment {
  return {
    id: '1',
    author: 'bot',
    body: '',
    createdAt: '2026-01-01T00:00:00Z',
    source: 'human',
    ...over,
  };
}

test('off mode — keeps everything regardless of overlap', () => {
  const findings = [mkFinding({ title: 'SQL injection in handler', file: 'h.ts', line: 5 })];
  const comments = [mkComment({ body: 'SQL injection in handler', file: 'h.ts', line: 5 })];
  const result = dedupeAgainstExisting(findings, comments, 'off');
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
});

test('strict mode — drops a near-duplicate at same file/line', () => {
  const findings = [
    mkFinding({
      title: 'User input flows into raw database query unsafely',
      body: 'User input flows into the raw database query string without parameterization or escaping; vulnerable to injection on this handler line.',
      file: 'src/db.ts',
      line: 42,
    }),
  ];
  const comments = [
    mkComment({
      body: 'User input flows into the raw database query string without parameterization or escaping; vulnerable to injection on this handler line.',
      file: 'src/db.ts',
      line: 42,
    }),
  ];
  const result = dedupeAgainstExisting(findings, comments, 'strict');
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
});

test('strict mode — keeps when file differs', () => {
  const findings = [mkFinding({ title: 'leak', body: 'memory leak in foo', file: 'a.ts', line: 1 })];
  const comments = [mkComment({ body: 'memory leak in foo', file: 'b.ts', line: 1 })];
  const result = dedupeAgainstExisting(findings, comments, 'strict');
  assert.equal(result.kept.length, 1);
});

test('strict mode — keeps when lines too far apart', () => {
  const findings = [mkFinding({ title: 'leak', body: 'memory leak in foo bar baz qux', file: 'a.ts', line: 1 })];
  const comments = [mkComment({ body: 'memory leak in foo bar baz qux', file: 'a.ts', line: 100 })];
  const result = dedupeAgainstExisting(findings, comments, 'strict');
  assert.equal(result.kept.length, 1);
});

test('strict mode — tolerates ±3 line drift', () => {
  const findings = [
    mkFinding({
      title: 'auth check missing here',
      body: 'authorization check absent before the database write operation',
      file: 'a.ts',
      line: 50,
    }),
  ];
  const comments = [
    mkComment({
      body: 'authorization check absent before the database write operation here',
      file: 'a.ts',
      line: 52,
    }),
  ];
  const result = dedupeAgainstExisting(findings, comments, 'strict');
  assert.equal(result.kept.length, 0);
});

test('loose mode — higher threshold, keeps moderate overlaps', () => {
  const findings = [
    mkFinding({ title: 'minor naming issue', body: 'rename foo to bar for clarity', file: 'a.ts', line: 1 }),
  ];
  const comments = [
    mkComment({ body: 'consider renaming things for consistency project-wide', file: 'a.ts', line: 1 }),
  ];
  const result = dedupeAgainstExisting(findings, comments, 'loose');
  assert.equal(result.kept.length, 1);
});

test('dedupeWithinBatch — drops near-duplicates within same batch', () => {
  const a = mkFinding({ title: 'duplicate finding title here', file: 'a.ts', line: 1 });
  const b = mkFinding({ title: 'duplicate finding title here', file: 'a.ts', line: 1 });
  const result = dedupeWithinBatch([a, b]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 1);
});

test('dedupeWithinBatch — keeps same title on different lines', () => {
  const a = mkFinding({ title: 'same title elsewhere', file: 'a.ts', line: 1 });
  const b = mkFinding({ title: 'same title elsewhere', file: 'a.ts', line: 99 });
  const result = dedupeWithinBatch([a, b]);
  assert.equal(result.kept.length, 2);
});

test('dedupeWithinBatch — off mode keeps everything', () => {
  const a = mkFinding({ title: 'duplicate finding title here', file: 'a.ts', line: 1 });
  const b = mkFinding({ title: 'duplicate finding title here', file: 'a.ts', line: 1 });
  const result = dedupeWithinBatch([a, b], 'off');
  assert.equal(result.kept.length, 2);
  assert.equal(result.dropped.length, 0);
});

test('dedupeWithinBatch — strict folds a same-file near-line duplicate that lacks a line on one side', () => {
  // one reviewer omitted the line; the other pinned it — same file, strongly
  // overlapping title → the same issue, folded.
  const a = mkFinding({
    title: 'hidden foreign key column exposed on the fact table',
    body: 'the surrogate key column is visible and defaults summarizeBy to count',
    file: 'model/Fact.tmdl',
    line: 80,
  });
  const b = mkFinding({
    title: 'hidden foreign key column exposed on the fact table',
    body: 'the surrogate key column is visible and defaults summarizeBy to count',
    file: 'model/Fact.tmdl',
  });
  const result = dedupeWithinBatch([a, b], 'strict');
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 1);
});

test('dedupeWithinBatch — loose folds a same-file duplicate reported at different lines; strict keeps both', () => {
  const mk = (line: number) =>
    mkFinding({
      title: 'string join relationship uses mismatched column names',
      body: 'the relationship joins Offering to OfferingName by string and was auto-detected instead of using a surrogate key',
      file: 'model/relationships.tmdl',
      line,
    });
  // Same finding surfaced by two reviewers at nearby-but-not-equal lines.
  assert.equal(dedupeWithinBatch([mk(192), mk(196)], 'strict').kept.length, 2);
  const loose = dedupeWithinBatch([mk(192), mk(196)], 'loose');
  assert.equal(loose.kept.length, 1);
  assert.equal(loose.dropped.length, 1);
});
