function normalizedSet(values) {
  return new Set((values ?? []).map((value) => String(value).toLowerCase()));
}

function nonEmptyList(value) {
  return Array.isArray(value) && value.length > 0;
}

function hasStackExpectations(expected = {}) {
  return [
    expected?.stack?.include,
    expected?.stack?.exclude,
    expected?.dependencies?.include,
    expected?.dependencies?.exclude,
  ].some(nonEmptyList);
}

export function stackExpectationFailures(expected = {}, stack = {}) {
  const failures = [];
  const tags = normalizedSet(stack.tags);
  const dependencies = normalizedSet(stack.dependencies);

  for (const tag of expected?.stack?.include ?? []) {
    if (!tags.has(String(tag).toLowerCase())) failures.push(`stack missing ${safeLogValue(tag)}`);
  }
  for (const tag of expected?.stack?.exclude ?? []) {
    if (tags.has(String(tag).toLowerCase())) failures.push(`stack unexpectedly includes ${safeLogValue(tag)}`);
  }
  for (const dependency of expected?.dependencies?.include ?? []) {
    if (!dependencies.has(String(dependency).toLowerCase())) failures.push(`dependency missing ${safeLogValue(dependency)}`);
  }
  for (const dependency of expected?.dependencies?.exclude ?? []) {
    if (dependencies.has(String(dependency).toLowerCase())) failures.push(`dependency unexpectedly includes ${safeLogValue(dependency)}`);
  }
  return failures;
}

export function requiredEvalArtifacts(expected = {}) {
  const required = ['pr-review-findings.json'];
  if ((expected.must_dispatch?.length ?? 0) > 0 || (expected.must_not_dispatch?.length ?? 0) > 0) {
    required.push('passes.json');
  }
  if (hasStackExpectations(expected)) required.push('stack.json');
  return required;
}

export function hasEvalAssertions(expected = {}) {
  return [expected.must_find, expected.must_not_find, expected.must_dispatch, expected.must_not_dispatch]
    .some(nonEmptyList) || hasStackExpectations(expected);
}

export function matchExpectedFindings(patterns = [], findings = [], distinct = false) {
  const candidates = patterns.map((pattern) => {
    const re = new RegExp(pattern, 'is');
    return findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => re.test(`${finding.title ?? ''}\n${finding.body ?? ''}`))
      .map(({ index }) => index);
  });
  if (!distinct) {
    return patterns.map((pattern, index) => ({
      pattern,
      finding: candidates[index][0] === undefined ? null : findings[candidates[index][0]],
    }));
  }

  const findingOwner = Array(findings.length).fill(-1);
  const assignment = Array(patterns.length).fill(-1);
  const assign = (patternIndex, seen) => {
    for (const findingIndex of candidates[patternIndex]) {
      if (seen.has(findingIndex)) continue;
      seen.add(findingIndex);
      const owner = findingOwner[findingIndex];
      if (owner === -1 || assign(owner, seen)) {
        findingOwner[findingIndex] = patternIndex;
        assignment[patternIndex] = findingIndex;
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < patterns.length; index++) assign(index, new Set());
  return patterns.map((pattern, index) => ({
    pattern,
    finding: assignment[index] === -1 ? null : findings[assignment[index]],
  }));
}

export function safeLogValue(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * The two defects planted in the acceptance fixture, and how a finding ACCUSES
 * the control handler of one.
 *
 * Matched against the TITLE only. The title is the accusation; the body is where
 * the reasoning lives, and reasoning legitimately names the other rule in order to
 * rule it OUT — "a separate defect from the SQL-helper issue: greetHandler already
 * uses the parameterised q(), so fixing ACC-SQL-001 does not fix this" is DEFENDING
 * the control. Matching the body counted that as an attack and failed the cell.
 *
 * Four correct findings about the control have now failed this assertion;
 * evals/acceptance/expected.yaml records the first three. The check discriminates
 * by WHERE the text sits, never by parsing prose for contrast — the same structural
 * instinct that already excludes the verifier, which quotes what it adjudicates.
 */
export const PLANTED_DEFECTS = [
  ['SQL injection', /sql injection|ACC-SQL-001/i],
  ['the missing audit call', /ACC-LOG-002/i],
];

/** The planted defect a finding accuses the control of, or undefined. */
export function accusedPlantedDefect(finding, planted = PLANTED_DEFECTS) {
  const title = String(finding?.title ?? '');
  for (const [what, re] of planted) if (re.test(title)) return what;
  return undefined;
}
