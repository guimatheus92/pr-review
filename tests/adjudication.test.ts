import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionableFindings, findingCandidates, parseAdjudication, type Adjudication } from '../src/dispatch/adjudication.js';
import { ADJUDICATION_BRIEF, PASS_RULES, REVIEW_EVIDENCE_RULES, prepareSessionContext, runSingleSession } from '../src/dispatch/single-session.js';
import { attemptOutputPath, readPhase1Candidates, verifierAttemptOutputPath } from '../src/dispatch/delivery.js';
import { finalizeReview, runReview } from '../src/commands/review.js';
import { loadVerifyContext, runChecks } from '../src/commands/verify.js';
import { controlDirForRun } from '../src/util/tmp.js';
import type { ExistingComment, Finding, GatherOutput, ReviewerOutput } from '../src/types.js';
import type { PrProvider } from '../src/providers/types.js';

const finding: Finding = { severity: 'HIGH', title: 'Shared input is absent', body: 'The local model cannot receive a shared input.', file: 'src/model.ts', line: 4 };
const outputs: ReviewerOutput[] = ['contracts', 'types'].map(reviewerName => ({
  reviewerName, findings: [{ ...finding }], model: 'test', rawOutput: '', durationMs: 0, exitCode: 0,
}));
const candidates = findingCandidates(outputs);
const rejected: Adjudication = { schemaVersion: 1, additions: [], decisions: candidates.map(candidate => ({
  findingId: candidate.id, action: 'reject', reason: 'Shared input is merged before binding.',
  evidence: ['skills-project.md: Shared input contract', 'pr-context.md: input binding'],
})) };

test('review and adjudication preserve supported preventative concerns without requiring an incident', () => {
  assert.match(REVIEW_EVIDENCE_RULES, /Preventative review does not require an already-failed deployment or incident/);
  assert.match(PASS_RULES, /do not invent a rule violation to justify advice/);
  const amendment = ADJUDICATION_BRIEF.indexOf('Amend before considering rejection');
  const rejection = ADJUDICATION_BRIEF.indexOf('Reject when the underlying premise is false');
  assert.ok(amendment >= 0 && rejection > amendment);
  assert.match(ADJUDICATION_BRIEF, /remove unsupported claims about failure, missing validation, or policy violations/);
  assert.match(ADJUDICATION_BRIEF, /representative first, then reject the duplicates with its exact candidate ID/);
});

test('adjudication rejects two correlated claims without emitting a reviewer-correction finding', () => {
  const original = JSON.stringify(outputs);
  assert.equal(new Set(candidates.map(candidate => candidate.id)).size, 2);
  assert.deepEqual(findingCandidates(outputs), candidates);
  assert.deepEqual(actionableFindings(candidates, parseAdjudication(JSON.stringify(rejected), candidates)), []);
  assert.equal(JSON.stringify(outputs), original);
});

test('adjudication preserves accepted defects and amended observations with originals unchanged', () => {
  const replacement = { ...finding, severity: 'MEDIUM' as const, title: 'Generated output changed', body: 'The generated contract changed; check the producing toolchain.' };
  const decision: Adjudication = { schemaVersion: 1, additions: [], decisions: [
    { ...rejected.decisions[0]!, action: 'accept' },
    { ...rejected.decisions[1]!, action: 'amend', finding: replacement },
  ] };
  assert.deepEqual(actionableFindings(candidates, decision), [finding, replacement]);
  assert.equal(outputs[1]!.findings[0]!.severity, 'HIGH');
});

test('adjudication refuses incomplete, duplicate, unknown, malformed, or unsupported decisions', () => {
  const invalid: unknown[] = [
    [], { ...rejected, schemaVersion: 2 }, { ...rejected, decisions: [] },
    { ...rejected, decisions: [rejected.decisions[0], rejected.decisions[0]] },
    { ...rejected, decisions: [{ ...rejected.decisions[0], findingId: 'invented' }, rejected.decisions[1]] },
    { ...rejected, decisions: [{ ...rejected.decisions[0], action: 'uncertain' }, rejected.decisions[1]] },
    { ...rejected, decisions: [{ ...rejected.decisions[0], evidence: [] }, rejected.decisions[1]] },
    { ...rejected, decisions: [{ ...rejected.decisions[0], reason: '' }, rejected.decisions[1]] },
    { ...rejected, decisions: [{ ...rejected.decisions[0], finding }, rejected.decisions[1]] },
    { ...rejected, decisions: [{ ...rejected.decisions[0], action: 'amend' }, rejected.decisions[1]] },
    { ...rejected, additions: [{ severity: 'HIGH', body: 'missing title' }] },
    { ...rejected, unexpected: true },
  ];
  for (const record of invalid) assert.throws(() => parseAdjudication(JSON.stringify(record), candidates));
  assert.throws(() => parseAdjudication(' '.repeat(1024 * 1024 + 1), candidates), /exceeds/);
  assert.throws(() => parseAdjudication(JSON.stringify(rejected), [candidates[0]!, candidates[0]!]), /duplicate candidate/);
});

test('empty review has an empty complete adjudication and candidate IDs bind finding contents', () => {
  assert.deepEqual(actionableFindings([], { schemaVersion: 1, decisions: [], additions: [] }), []);
  const changed = findingCandidates([{ ...outputs[0]!, findings: [{ ...finding, line: 5 }] }]);
  assert.notEqual(changed[0]!.id, candidates[0]!.id);
});

test('adjudication finalization, posting, resume and audit use decisions while preserving all original findings', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-adjudication-e2e-'));
  const runId = 'adjudication-regression';
  const outDir = join(home, '.pr-review/runs', runId);
  mkdirSync(outDir, { recursive: true });
  const prUrl = 'https://github.com/example/project/pull/1';
  const gather: GatherOutput = {
    pr: { provider: 'github', owner: 'example', repo: 'project', number: 1, url: prUrl },
    metadata: { title: 'Contract change', description: 'A contract with shared inputs and a generated output.', author: 'test',
      headSha: 'head', baseSha: 'base', headBranch: 'feature', baseBranch: 'main', state: 'open', isDraft: false,
      labels: [], linkedItems: [], createdAt: '', updatedAt: '' },
    changedFiles: [{ path: 'src/model.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1,5 +1,5 @@\n first\n second\n-old\n+new\n fourth\n fifth' }],
    existingComments: [], gatheredAt: new Date().toISOString(), changedFilesComplete: true,
  };
  const originals = [finding, { ...finding, title: 'Consumer cannot bind', body: 'The consumer has a different model.' },
    { ...finding, title: 'Generated API changed', body: 'The generated API changed and every deployment will fail.', severity: 'MEDIUM' as const }];
  const replacement = { ...originals[2]!, body: 'The generated API changed with the producing toolchain; validate compatibility for the supported targets.' };
  const opts = {
    prUrl, gather, passes: ['contracts', 'types', 'generated'].map(name => ({ name, source: `/${name}.md`, body: 'Review', matchedBy: 'baseline' as const, matchedOn: [] })),
    indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: [], outDir, invokeCompanions: false,
    defaultModel: 'explicit-model', controlDir: controlDirForRun(outDir, home),
    execution: { dryRun: true, publish: false, dedupeMode: 'off' as const, adjudicate: true, failOn: 'HIGH' as const },
  };
  try {
    writeFileSync(join(outDir, 'pr-review-gather.json'), JSON.stringify(gather));
    writeFileSync(join(outDir, 'stack.json'), JSON.stringify({ languages: ['TypeScript'], dependencies: [], ecosystems: [], notes: [] }));
    writeFileSync(join(outDir, 'companions.json'), JSON.stringify({ plannedReviewers: [], missingReviewers: [], duplicateReviewers: [] }));
    writeFileSync(join(outDir, 'capabilities.json'), JSON.stringify({ runtime: 'copilot', model: 'explicit-model', installedPlugins: [], mcpServers: [] }));
    const context = prepareSessionContext(opts);
    const plan = context.dispatchPlan!;
    let calls = 0;
    const session = await runSingleSession(opts, context, async () => {
      calls++;
      if (calls === 1) {
        for (const [index, reviewer] of plan.reviewers.entries()) writeFileSync(attemptOutputPath(reviewer, 1), JSON.stringify([originals[index]]));
      } else {
        writeFileSync(verifierAttemptOutputPath(plan.verifier, 1), JSON.stringify({ schemaVersion: 1, additions: [],
          decisions: readPhase1Candidates(plan).map((candidate, index) => ({ findingId: candidate.id,
            action: index < 2 ? 'reject' : 'amend', reason: index < 2 ? 'Supported shared input.' : 'Observed drift without proven universal failure.',
            evidence: ['project contract and diff'], ...(index === 2 ? { finding: replacement } : {}) })) }));
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    assert.equal(calls, 2);
    const finalized = await finalizeReview({ prUrl, outDir, gather, outputs: session.outputs, dedupeMode: 'off', publish: false, dryRun: true,
      failOn: 'HIGH', findingsUnavailable: session.findingsUnavailable, deliveryState: session.deliveryState, homeOverride: home, overallStart: Date.now() });
    assert.equal(finalized.exitCode, 0, 'rejected HIGH findings must not trigger fail-on');
    const readArtifact = () => JSON.parse(readFileSync(join(outDir, 'pr-review-findings.json'), 'utf8'));
    const artifact = readArtifact();
    assert.deepEqual(artifact.finalFindings, originals);
    assert.deepEqual(artifact.actionableFindings, [replacement]);
    assert.deepEqual(artifact.publication, { minimumSeverity: 'NIT', eligibleCount: 1, suppressedCount: 0 });
    assert.ok(finalized.summary.includes('## Retained Evidence'));
    assert.ok(finalized.summary.includes(replacement.body));
    for (const original of originals) assert.ok(finalized.summary.includes(original.body));
    const verify = async () => runChecks(await loadVerifyContext({ runId, home, offline: true }));
    const rows = await verify();
    assert.equal(rows.find(row => row.id === 'INV-OUT-02')?.status, 'pass');
    assert.equal(rows.find(row => row.id === 'INV-OUT-01')?.status, 'pass');
    const comments: ExistingComment[] = [];
    const posted: Finding[] = [];
    const provider: PrProvider = {
      name: 'github', parseUrl: () => gather.pr, fetchMetadata: async () => gather.metadata, fetchChangedFiles: async () => gather.changedFiles,
      fetchExistingComments: async () => comments, isTransientError: () => false,
      postLineComment: async (_ref, entry) => {
        posted.push(entry);
        comments.push({ id: String(posted.length), author: 'test', body: entry.body, file: entry.file, line: entry.line, createdAt: new Date().toISOString(), source: 'bot' });
        return { id: String(posted.length) };
      },
    };
    await assert.rejects(runReview({ prUrl, runDir: outDir, resumeRunId: runId, homeOverride: home, provider, dryRun: true, publish: false, adjudicate: false }), /adjudication-mismatch/);
    const resumed = await runReview({ prUrl, runDir: outDir, resumeRunId: runId, homeOverride: home, provider, publish: true,
      resumePlannedSessionFn: async () => { assert.fail('complete replay must not redispatch'); } });
    assert.equal(resumed.exitCode, 0);
    assert.deepEqual(posted, [replacement]);
    await runReview({ prUrl, runDir: outDir, resumeRunId: runId, homeOverride: home, provider, publish: true });
    assert.equal(posted.length, 1, 'replay cannot post rejected findings or duplicate the accepted amendment');
    assert.deepEqual(readArtifact().finalFindings, originals);
    assert.deepEqual(readArtifact().actionableFindings, [replacement]);
    assert.ok(existsSync(join(outDir, 'posted.marker')));
    writeFileSync(join(outDir, 'pr-review-findings.json'), JSON.stringify({ ...readArtifact(), actionableFindings: originals }));
    const tampered = await verify();
    assert.equal(tampered.find(row => row.id === 'INV-OUT-02')?.status, 'fail');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});