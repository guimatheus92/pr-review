import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildValidLinesMap } from '../../dist/dispatch/line-snap.js';

export function publicationFixtureFindings(gather, scenario = 'mixed') {
  const anchors = [...buildValidLinesMap(gather.changedFiles.filter((file) => !file.excluded))]
    .flatMap(([file, lines]) => [...lines].sort((left, right) => left - right).map((line) => ({ file, line })));
  if (anchors.length < 5) throw new Error('publication fixture needs at least five valid diff anchors');
  const definitions = [
    ['CRITICAL', 'Credential export', 'Credentials can leave the protected storage boundary.'],
    ['HIGH', 'Tenant authorization', 'Tenant authorization permits access to another account.'],
    ['MEDIUM', 'Numeric precision', 'Fractional precision is lost during numeric conversion.'],
    ['LOW', 'Redundant lookup', 'Repeated database lookups consume unnecessary resources.'],
    ['NIT', 'Local naming', 'Local naming differs from neighboring declarations.'],
  ];
  const findings = definitions.map(([severity, title, body], index) => ({ severity, title, body, ...anchors[index] }));
  if (scenario === 'medium') return [findings[2]];
  if (scenario === 'high') return [findings[1]];
  if (scenario !== 'mixed') throw new Error(`unknown publication fixture scenario: ${scenario}`);
  return [...findings, { ...findings[3], severity: 'HIGH' }];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runDir = process.cwd();
  const plan = JSON.parse(readFileSync(join(runDir, 'dispatch-plan.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(runDir, 'delivery-state.json'), 'utf8'));
  const attempt = state.runtimeAttempts.at(-1);
  const gather = JSON.parse(readFileSync(join(runDir, 'pr-review-gather.json'), 'utf8'));
  const findings = publicationFixtureFindings(gather, process.env.PR_REVIEW_PUBLICATION_SCENARIO ?? 'mixed');
  if (!attempt || attempt.status !== 'started') throw new Error('fixture runtime requires a reserved attempt');
  if (attempt.kind === 'verifier') {
    const phase1 = JSON.parse(readFileSync(plan.phase1Path, 'utf8'));
    const collected = phase1.reviewers.flatMap((reviewer) => reviewer.findings);
    if (JSON.stringify(collected) !== JSON.stringify(findings)) throw new Error('verifier did not receive every Phase-1 finding');
    writeFileSync(join(plan.verifier.attemptsDir, `attempt-${state.verifier.attempts}.json`), '[]');
  } else {
    for (const name of attempt.reviewers) {
      const reviewer = plan.reviewers.find((entry) => entry.name === name);
      if (!reviewer) throw new Error('fixture received an unplanned reviewer');
      writeFileSync(join(reviewer.attemptsDir, `attempt-${state.reviewerAttempts[name]}.json`),
        JSON.stringify(reviewer === plan.reviewers[0] ? findings : []));
      if (reviewer.capabilityPath) writeFileSync(reviewer.capabilityPath, JSON.stringify({ available: [], attempted: [], used: [], notes: '' }));
    }
  }
}