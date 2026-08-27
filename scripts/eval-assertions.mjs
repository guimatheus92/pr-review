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