import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  accusedPlantedDefect,
  hasEvalAssertions,
  matchExpectedFindings,
  requiredEvalArtifacts,
  safeLogValue,
  stackExpectationFailures,
} from '../scripts/eval-assertions.mjs';

test('stackExpectationFailures — dependency expectations use dependencies, not union tags', () => {
  const expected = {
    stack: { include: ['c#'], exclude: ['smalltalk'] },
    dependencies: { include: ['mstest.testframework'], exclude: ['xunit'] },
  };
  assert.deepEqual(
    stackExpectationFailures(expected, {
      tags: ['c#', 'mstest.testframework'],
      dependencies: [],
    }),
    ['dependency missing "mstest.testframework"'],
  );
  assert.deepEqual(
    stackExpectationFailures(expected, {
      tags: ['c#', 'mstest.testframework'],
      dependencies: ['mstest.testframework'],
    }),
    [],
  );
});

test('requiredEvalArtifacts — negative routing and stack assertions still require evidence files', () => {
  assert.deepEqual(
    requiredEvalArtifacts({ must_not_dispatch: ['x'], stack: { exclude: ['smalltalk'] } }),
    ['pr-review-findings.json', 'passes.json', 'stack.json'],
  );
  assert.deepEqual(requiredEvalArtifacts({ must_find: ['x'] }), ['pr-review-findings.json']);
});

test('hasEvalAssertions — negative-only control fixtures are meaningful', () => {
  assert.equal(hasEvalAssertions({}), false);
  assert.equal(hasEvalAssertions({ stack: {}, dependencies: {} }), false);
  assert.equal(hasEvalAssertions({ stack: { include: [], exclude: [] } }), false);
  assert.equal(hasEvalAssertions({ must_not_find: ['forbidden'] }), true);
  assert.equal(hasEvalAssertions({ must_not_dispatch: ['wrong-pass'] }), true);
  assert.equal(hasEvalAssertions({ stack: { include: ['c#'] } }), true);
});

test('matchExpectedFindings — distinct contracts cannot reuse one generic finding', () => {
  const findings = [
    { title: 'Contract issue', body: 'authorization policy and route filter argument are not independently asserted' },
    { title: 'Filter oracle', body: 'route filter argument derives its expected value from production metadata' },
  ];
  const patterns = ['authorization.*policy', 'filter.*argument'];
  const reused = matchExpectedFindings(patterns, findings, false);
  assert.equal(reused[0].finding, findings[0]);
  assert.equal(reused[1].finding, findings[0]);

  const distinct = matchExpectedFindings(patterns, findings, true);
  assert.equal(distinct[0].finding, findings[0]);
  assert.equal(distinct[1].finding, findings[1]);

  const greedyTrap = matchExpectedFindings(
    ['filter', 'filter.*circular'],
    [
      { title: 'Filter circular', body: 'oracle' },
      { title: 'Filter only', body: 'other issue' },
    ],
    true,
  );
  assert.equal(greedyTrap[0].finding?.title, 'Filter only');
  assert.equal(greedyTrap[1].finding?.title, 'Filter circular');
});

test('matchExpectedFindings — patterns span the title and body boundary', () => {
  const [match] = matchExpectedFindings(
    ['(?=.*authorization)(?=.*policy)'],
    [{ title: 'Authorization contract', body: 'The test does not assert the policy.' }],
  );
  assert.equal(match.finding?.title, 'Authorization contract');
});

test('csharp contract eval pair — defective oracle drifts with production while control pins values', () => {
  const fixture = (name: string, file: string) => readFileSync(
    fileURLToPath(new URL(`../evals/fixtures/${name}/${file}`, import.meta.url)),
    'utf8',
  );
  const defective = fixture('csharp-contract-tests', 'diff.patch');
  const safe = fixture('csharp-contract-tests-safe', 'diff.patch');
  const defectiveTest = defective.slice(defective.indexOf('diff --git a/tests/'));
  const safeTest = safe.slice(safe.indexOf('diff --git a/tests/'));

  assert.match(defectiveTest, /expectedFilterArgument = action\.GetParameters\(\)\[0\]\.Name/);
  assert.doesNotMatch(defectiveTest, /authorization\.Policy/);
  assert.doesNotMatch(defectiveTest, /authorization\.AuthenticationSchemes/);
  assert.doesNotMatch(defectiveTest, /Assert\.AreEqual\("workspaceResourceId", routeFilter\.ArgumentName\)/);
  assert.match(safeTest, /Assert\.AreEqual\("Catalog\.Read", authorization\.Policy\)/);
  assert.match(safeTest, /Assert\.AreEqual\("Service,OnBehalfOf", authorization\.AuthenticationSchemes\)/);
  assert.match(safeTest, /Assert\.AreEqual\("workspaceResourceId", routeFilter\.ArgumentName\)/);

  const defectiveExpected = parseYaml(fixture('csharp-contract-tests', 'expected.yaml')) as {
    must_find: string[];
    distinct_findings?: boolean;
  };
  const safeExpected = parseYaml(fixture('csharp-contract-tests-safe', 'expected.yaml')) as {
    must_not_find: string[];
  };
  assert.equal(defectiveExpected.distinct_findings, true);
  assert.deepEqual(safeExpected.must_not_find, defectiveExpected.must_find);
});

test('safeLogValue — reviewer-derived control characters stay escaped on one log line', () => {
  const rendered = safeLogValue('title\r\nforged line\u0007');
  assert.equal(rendered, '"title\\r\\nforged line\\u0007"');
  assert.equal(rendered.split(/\r?\n/).length, 1);
});

test('stackExpectationFailures — expected values cannot inject log lines', () => {
  const failures = stackExpectationFailures(
    {
      stack: { include: ['c#\nforged'] },
      dependencies: { include: ['package\r\nforged'] },
    },
    { tags: [], dependencies: [] },
  );
  assert.deepEqual(failures, [
    'stack missing "c#\\nforged"',
    'dependency missing "package\\r\\nforged"',
  ]);
  assert.ok(failures.every((failure) => failure.split(/\r?\n/).length === 1));
});
// Titles copied from real acceptance runs. The control assertion exists to catch a
// reviewer crying wolf on correct code; it must not fire on a correct finding that
// names the planted rule in order to rule it OUT. Four such findings have failed it
// — evals/acceptance/expected.yaml records the first three.
test('accusedPlantedDefect — a contrastive body is not an accusation; a title is', () => {
  const contrastiveBody =
    'User.id is declared as number but req.params.id is a string. This is a separate ' +
    'defect from the SQL-helper issue: greetHandler already uses the parameterised q(), ' +
    'so fixing ACC-SQL-001 does not fix this. ACC-LOG-002 is likewise unrelated.';

  for (const title of [
    'req.params.id is never parsed into the numeric id the User type declares',
    "Route param `id` is never parsed or validated against `User['id']: number`",
  ]) {
    assert.equal(
      accusedPlantedDefect({ title, body: contrastiveBody }),
      undefined,
      `a correct finding titled "${title}" must not read as an accusation`,
    );
  }

  // The other direction, which is what the assertion is FOR: gutting it would be a
  // silent regression, because a check that never fires looks exactly like a pass.
  assert.equal(accusedPlantedDefect({ title: 'SQL injection in greetHandler', body: '' }), 'SQL injection');
  assert.equal(accusedPlantedDefect({ title: 'Violates ACC-SQL-001', body: '' }), 'SQL injection');
  assert.equal(accusedPlantedDefect({ title: 'ACC-LOG-002: audit call missing', body: '' }), 'the missing audit call');
  assert.equal(accusedPlantedDefect({ title: 'sql INJECTION here', body: '' }), 'SQL injection');
  assert.equal(accusedPlantedDefect({}), undefined);
});
