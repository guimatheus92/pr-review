import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleConsolidated,
  assemblePhase1,
  createDeliveryState,
  createDispatchPlan,
  hasSevereFindings,
  inspectReviewerDelivery,
  promoteReviewerAttempt,
  readAuthoritativeDeliveryState,
  recordCodexResult,
  reconcileDeliveryCompletion,
  reserveCodexAttempt,
  writeDeliveryState,
} from '../src/dispatch/delivery.js';
import type { ReviewerOutput } from '../src/types.js';
import { sha256File } from '../src/util/atomic-json.js';

function finding(severity = 'MEDIUM') {
  return { severity, title: 'title', body: 'body', file: 'src/a.ts', line: 1 };
}

test('inspectReviewerDelivery — classifies valid empty, missing, and invalid sidecars in plan order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-delivery-'));
  try {
    const files = {
      first: join(dir, 'raw-first.json'),
      empty: join(dir, 'raw-empty.json'),
      missing: join(dir, 'raw-missing.json'),
      invalid: join(dir, 'raw-invalid.json'),
    };
    writeFileSync(files.first, JSON.stringify([finding('HIGH')]));
    writeFileSync(files.empty, '[]');
    writeFileSync(files.invalid, JSON.stringify([{ nope: true }]));
    const inventory = inspectReviewerDelivery(files, 'model', 123);
    assert.deepEqual(inventory.planned, ['first', 'empty', 'missing', 'invalid']);
    assert.deepEqual(inventory.valid, ['first', 'empty']);
    assert.deepEqual(inventory.missing, ['missing']);
    assert.deepEqual(inventory.invalid, ['invalid']);
    assert.equal(inventory.complete, false);
    assert.equal(inventory.recoveredFindingCount, 1);
    assert.equal(inventory.severityCounts.HIGH, 1);
    assert.equal(inventory.deliveries[0]!.bytes, Buffer.byteLength(JSON.stringify([finding('HIGH')])));
    assert.match(inventory.deliveries[0]!.sha256!, /^[0-9a-f]{64}$/);
    assert.equal(hasSevereFindings(inventory.outputs), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assemblePhase1 — refuses partial delivery and atomically preserves planned order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-delivery-'));
  try {
    const path = join(dir, 'phase1-findings.json');
    const files = { second: join(dir, 'second.json'), first: join(dir, 'first.json') };
    writeFileSync(files.second, '[]');
    let inventory = inspectReviewerDelivery(files, 'model', 0);
    assert.throws(() => assemblePhase1(path, inventory), /1\/2 valid, 1 missing/);
    assert.equal(existsSync(path), false);
    writeFileSync(files.first, JSON.stringify([finding()]));
    inventory = inspectReviewerDelivery(files, 'model', 0);
    assemblePhase1(path, inventory);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { reviewers: Array<{ name: string }> };
    assert.deepEqual(parsed.reviewers.map((reviewer) => reviewer.name), ['second', 'first']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assembleConsolidated — appends a required verifier without mutating phase-1 outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-delivery-'));
  try {
    const path = join(dir, 'single-session-findings.json');
    const output = (reviewerName: string, severity: 'HIGH' | 'LOW'): ReviewerOutput => ({
      reviewerName,
      model: 'model',
      findings: [finding(severity) as ReviewerOutput['findings'][number]],
      rawOutput: '',
      durationMs: 0,
      exitCode: 0,
    });
    const phase1 = [output('one', 'HIGH')];
    assembleConsolidated(path, phase1, output('verifier', 'LOW'));
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { reviewers: Array<{ name: string }> };
    assert.deepEqual(parsed.reviewers.map((reviewer) => reviewer.name), ['one', 'verifier']);
    assert.deepEqual(phase1.map((reviewer) => reviewer.reviewerName), ['one']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delivery state — enabled Codex blocks completion until its authenticated result is recorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-delivery-'));
  try {
    const raw = join(dir, 'raw-reviewer.json');
    writeFileSync(raw, '[]');
    const plan = createDispatchPlan({
      runId: 'run', runDir: dir, createdAt: new Date(0).toISOString(),
      pr: { provider: 'github', url: 'u', owner: 'o', repo: 'r', number: 1 },
      metadata: { headSha: 'h', baseSha: 'b', headBranch: 'f', baseBranch: 'main', state: 'open', isDraft: false },
      runtime: 'copilot', runtimeBinary: 'copilot', disabledMcpServers: [], model: 'm', timeoutMs: 1,
      phase1Path: join(dir, 'phase1-findings.json'), findingsPath: join(dir, 'single-session-findings.json'),
      execution: { dryRun: true, publish: false, dedupeMode: 'strict' },
      configProjection: {}, configFingerprint: 'f', artifacts: [],
      reviewers: [{
        name: 'reviewer', kind: 'pass', description: 'Review', agentType: 'general-purpose',
        promptTemplate: '{{PR_REVIEW_OUTPUT_PATH}}', canonicalOutputPath: raw,
        attemptsDir: join(dir, 'attempts'), maxAttempts: 3,
      }],
      verifier: { enabled: false, maxAttempts: 3 },
      codex: { enabled: true, contextPath: join(dir, 'pr-context.md'), attemptsDir: join(dir, 'codex-attempts'), maxAttempts: 3 },
    });
    const inventory = inspectReviewerDelivery({ reviewer: raw }, 'm', 0);
    const state = createDeliveryState(plan, inventory);
    state.phase1 = 'valid';
    state.verifier.state = 'skipped-disabled';
    writeFileSync(plan.findingsPath, JSON.stringify({ reviewers: [{ name: 'reviewer', findings: [] }] }));
    state.consolidated = 'valid';
    state.consolidatedDigest = sha256File(plan.findingsPath);
    reconcileDeliveryCompletion(plan, state);
    assert.equal(state.kind, 'recoverable-incomplete');
    assert.equal(state.codex.state, 'pending');

    const codex: ReviewerOutput = {
      reviewerName: 'codex', model: 'codex', findings: [finding('LOW') as ReviewerOutput['findings'][number]],
      rawOutput: '[]', durationMs: 1, exitCode: 0,
    };
    reserveCodexAttempt(plan, state);
    assert.equal(state.codex.attempts, 1);
    recordCodexResult(plan, state, codex);
    assert.equal(state.kind, 'complete');
    const mirror = join(dir, 'delivery-state.json');
    const authority = join(dir, 'control', 'run', 'delivery-state.json');
    writeDeliveryState(state, mirror, authority);
    assert.deepEqual(readAuthoritativeDeliveryState(authority, plan).codex.output?.findings, codex.findings);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('promoteReviewerAttempt — rejects a canonical sidecar without a valid provisional artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-delivery-'));
  try {
    const reviewer = {
      name: 'reviewer',
      kind: 'pass' as const,
      description: 'Review',
      agentType: 'general-purpose',
      promptTemplate: '{{PR_REVIEW_OUTPUT_PATH}}',
      canonicalOutputPath: join(dir, 'raw-reviewer.json'),
      attemptsDir: join(dir, 'attempts'),
      maxAttempts: 3,
    };
    writeFileSync(reviewer.canonicalOutputPath, '[]', 'utf8');
    const result = promoteReviewerAttempt(reviewer, 1, 'model', 0);
    assert.equal(result.status, 'collision');
    assert.match(result.error ?? '', /without a valid attempt-scoped artifact/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});