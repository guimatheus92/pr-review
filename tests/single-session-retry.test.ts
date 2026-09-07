import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTransientOrchestratorFailure,
  prepareSessionContext,
  resumePlannedSession,
  runSingleSession,
  type SessionContext,
  type SingleSessionOptions,
} from '../src/dispatch/single-session.js';
import { attemptOutputPath, verifierAttemptOutputPath } from '../src/dispatch/delivery.js';
import { sha256File } from '../src/util/atomic-json.js';
import { readReviewerProgress } from '../src/dispatch/reviewer-progress.js';
import { createDeliveryState, inspectReviewerDelivery, promoteReviewerAttempt, writeDeliveryState } from '../src/dispatch/delivery.js';

// spawnRuntime's resolved shape — the seam the fake must satisfy.
type SpawnResult = { stdout: string; stderr: string; exitCode: number };
type FakeSpawn = () => Promise<SpawnResult>;

const RATE_LIMIT = 'Server is temporarily limiting requests · Rate limited';
const findingsJson = (body: string) =>
  JSON.stringify({ reviewers: [{ name: 'quality', findings: [{ severity: 'MEDIUM', title: 't', body, file: 'a.ts', line: 1 }] }] });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-retry-'));
  const ctx = {
    findingsPath: join(dir, 'single-session-findings.json'),
    phase1Path: join(dir, 'phase1-findings.json'),
    orchestratorPrompt: '',
    passes: [],
    triageSkipped: [],
    reviewerFiles: { quality: join(dir, 'raw-quality.json') },
  } as unknown as SessionContext;
  const opts = { runtime: 'claude', outDir: dir, invokeCompanions: false } as unknown as SingleSessionOptions;
  return { dir, ctx, opts };
}

// Retry loop injects spawn (3rd arg) and a fast backoff (4th arg) so tests never sleep.
const run = (opts: SingleSessionOptions, ctx: SessionContext, spawn: FakeSpawn) =>
  runSingleSession(opts, ctx, spawn, [1]);

test('isTransientOrchestratorFailure — transient signatures are retriable', () => {
  const transient = [
    'Server is temporarily limiting requests',
    'Rate limited',
    'overloaded_error',
    'HTTP 429',
    'got status 529',
    // Observed live: the claude runtime drops the streaming connection mid-response.
    'API Error: Connection closed mid-response. The response above may be incomplete.',
    'socket hang up',
    'read ECONNRESET',
  ];
  for (const s of transient) {
    assert.equal(isTransientOrchestratorFailure(s), true, `expected transient: ${s}`);
  }
  // the stderr channel is checked too
  assert.equal(isTransientOrchestratorFailure('', 'overloaded'), true);
});

test('isTransientOrchestratorFailure — deterministic failures and timeouts are NOT retriable', () => {
  for (const s of ['[timed out]', 'SyntaxError: Unexpected token', 'permission denied', '']) {
    assert.equal(isTransientOrchestratorFailure(s), false, `expected non-transient: ${s}`);
  }
});

test('runSingleSession — retries once on a transient failure and recovers', async () => {
  const { ctx, opts } = setup();
  let calls = 0;
  const spawn: FakeSpawn = async () => {
    calls++;
    if (calls === 1) return { stdout: RATE_LIMIT, stderr: '', exitCode: 1 }; // dies, writes nothing
    writeFileSync(ctx.findingsPath, findingsJson('recovered'));
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const result = await run(opts, ctx, spawn);
  assert.equal(calls, 2);
  assert.equal(result.findingsUnavailable, false);
  assert.equal((result.outputs[0].findings[0] as { body: string }).body, 'recovered');
});

test('runSingleSession — does not retry a non-transient failure', async () => {
  const { ctx, opts } = setup();
  let calls = 0;
  const spawn: FakeSpawn = async () => {
    calls++;
    return { stdout: 'boom: fatal error', stderr: '', exitCode: 1 };
  };
  const result = await run(opts, ctx, spawn);
  assert.equal(calls, 1);
  assert.equal(result.findingsUnavailable, true);
});

test('runSingleSession — salvage-2: contract payload printed to stdout, no files written → findings recovered (the incident shape)', async () => {
  const { ctx, opts } = setup();
  const spawn: FakeSpawn = async () => ({
    // Narrated transcript: prose brackets + the consolidated payload printed instead of written.
    stdout: `I dispatched [quality] and [security] reviewers.\n${findingsJson('printed-not-written')}\nDONE`,
    stderr: '',
    exitCode: 0,
  });
  const result = await run(opts, ctx, spawn);
  assert.equal(result.findingsUnavailable, false, 'stdout salvage must recover the printed payload');
  const findings = result.outputs.flatMap((o) => o.findings);
  assert.equal(findings.length, 1);
  assert.equal((findings[0] as { body: string }).body, 'printed-not-written');
});

test('runSingleSession — complete raw reviewer sidecars recover an early coordinator exit', async () => {
  const { ctx, opts } = setup();
  ctx.reviewerFiles.security = join(ctx.findingsPath, '..', 'raw-security.json');
  const spawn: FakeSpawn = async () => {
    writeFileSync(ctx.reviewerFiles.quality!, JSON.stringify([]));
    writeFileSync(ctx.reviewerFiles.security!, JSON.stringify([
      { severity: 'HIGH', title: 't', body: 'recovered from reviewer', file: 'a.ts', line: 1 },
    ]));
    return { stdout: 'All agents complete. Collecting results now.', stderr: '', exitCode: 0 };
  };
  const result = await run(opts, ctx, spawn);
  assert.equal(result.findingsUnavailable, false);
  assert.deepEqual(result.outputs.map((output) => output.reviewerName), ['quality', 'security']);
  assert.equal(result.outputs[1]!.findings[0]!.body, 'recovered from reviewer');
});

test('runSingleSession — raw reviewer arrays override synthetic unparseable findings', async () => {
  const { ctx, opts } = setup();
  const spawn: FakeSpawn = async () => {
    writeFileSync(ctx.reviewerFiles.quality!, JSON.stringify([]));
    writeFileSync(ctx.findingsPath, JSON.stringify({ reviewers: [{
      name: 'quality',
      findings: [{
        severity: 'LOW',
        title: 'Unparseable output from quality',
        body: '[]',
        file: null,
        line: null,
      }],
    }] }));
    return { stdout: 'DONE', stderr: '', exitCode: 0 };
  };
  const result = await run(opts, ctx, spawn);
  assert.equal(result.findingsUnavailable, false);
  assert.equal(result.outputs[0]!.reviewerName, 'quality');
  assert.deepEqual(result.outputs[0]!.findings, []);
});

test('runSingleSession — partial raw reviewer sidecars remain a pipeline failure', async () => {
  const { ctx, opts } = setup();
  ctx.reviewerFiles.security = join(ctx.findingsPath, '..', 'raw-security.json');
  const spawn: FakeSpawn = async () => {
    writeFileSync(ctx.reviewerFiles.quality!, JSON.stringify([]));
    return { stdout: 'coordinator ended early', stderr: '', exitCode: 0 };
  };
  const result = await run(opts, ctx, spawn);
  assert.equal(result.findingsUnavailable, true);
  assert.deepEqual(result.outputs.map((output) => output.reviewerName), ['quality']);
});

test('runSingleSession — recovered reviewer names cannot inject stderr lines', async () => {
  const { ctx, opts } = setup();
  ctx.reviewerFiles['missing\nforged'] = join(ctx.findingsPath, '..', 'raw-missing.json');
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (value: string) => boolean }).write = (value) => (lines.push(String(value)), true);
  try {
    const result = await run(opts, ctx, async () => {
      writeFileSync(ctx.reviewerFiles.quality!, JSON.stringify([]));
      return { stdout: 'coordinator ended early', stderr: '', exitCode: 0 };
    });
    assert.equal(result.findingsUnavailable, true);
  } finally {
    process.stderr.write = original;
  }
  const diagnostic = lines.find((line) => line.includes('missing:')) ?? '';
  assert.match(diagnostic, /missing\\nforged/);
  assert.equal(diagnostic.trimEnd().split(/\r?\n/).length, 1);
});

test('runSingleSession — clears a stale findings file before retrying', async () => {
  const { ctx, opts } = setup();
  writeFileSync(ctx.findingsPath, findingsJson('stale-previous-run')); // leftover from a prior run
  let calls = 0;
  const spawn: FakeSpawn = async () => {
    calls++;
    if (calls === 1) return { stdout: RATE_LIMIT, stderr: '', exitCode: 1 }; // dies without writing
    writeFileSync(ctx.findingsPath, findingsJson('fresh'));
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const result = await run(opts, ctx, spawn);
  assert.equal(calls, 2); // if the stale file leaked, attempt 1 would "succeed" and never retry
  assert.equal((result.outputs[0].findings[0] as { body: string }).body, 'fresh');
});

test('runSingleSession — clears stale raw reviewer sidecars before dispatch', async () => {
  const { ctx, opts } = setup();
  writeFileSync(ctx.reviewerFiles.quality!, JSON.stringify([]));
  const result = await run(opts, ctx, async () => ({ stdout: 'no output', stderr: '', exitCode: 0 }));
  assert.equal(result.findingsUnavailable, true);
  assert.equal(result.outputs.length, 0);
  assert.equal(existsSync(ctx.reviewerFiles.quality!), false);
});

test('spawnPlannedBatch — a re-dispatched pass does not inherit the previous attempt capability sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-capability-stale-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: {
        title: 'Test PR', description: 'A complete description.', author: 'tester',
        headSha: 'abcdef1234567890', baseSha: '1234567890abcdef', baseBranch: 'main', headBranch: 'feature',
        labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const,
      },
      changedFiles: [{ path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' }],
      existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url,
      gather,
      passes: [{
        name: 'model-tools/model-review', source: '/model-review.md', body: 'Review carefully.',
        matchedBy: 'plugin' as const, matchedOn: [], origin: 'plugin' as const,
        plugin: 'model-tools', mcpServers: ['model-inspector'],
      }],
      indexEntries: [], stackTags: ['typescript'], installedCompanions: [], skipReviewers: [],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    const sidecar = ctx.capabilityFiles['model-tools/model-review']!;
    let sawStaleSidecarOnRecovery: boolean | null = null;
    let calls = 0;

    await runSingleSession(opts, ctx, async () => {
      calls++;
      if (calls === 1) {
        // Attempt 1 writes the sidecar but no Finding[] — the reviewer stays unresolved,
        // so Node re-dispatches it, and the sidecar must not survive into that attempt.
        writeFileSync(sidecar, JSON.stringify({
          reviewer: 'model-tools/model-review',
          available: ['model-inspector'], attempted: ['model-inspector'], used: ['model-inspector'],
          notes: 'attempt 1',
        }), 'utf8');
        return { stdout: 'DONE', stderr: '', exitCode: 0 };
      }
      sawStaleSidecarOnRecovery = existsSync(sidecar);
      for (const reviewer of plan.reviewers) writeFileSync(attemptOutputPath(reviewer, 2), '[]');
      return { stdout: 'DONE', stderr: '', exitCode: 0 };
    }, [1]);

    assert.equal(calls, 2, 'the unresolved pass must have been re-dispatched');
    assert.equal(sawStaleSidecarOnRecovery, false, 'attempt 2 starts with no attempt-1 capability evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — exit 0 with 18/22 sidecars selectively recovers four, preserves valid outputs, then verifies HIGH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-planned-recovery-'));
  try {
    const reviewerNames = Array.from({ length: 22 }, (_, index) => `pack/reviewer-${String(index + 1).padStart(2, '0')}`);
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: {
        title: 'Test PR', description: 'A complete description.', author: 'tester',
        headSha: 'abcdef1234567890', baseSha: '1234567890abcdef', baseBranch: 'main', headBranch: 'feature',
        labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const,
      },
      changedFiles: [{ path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' }],
      existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url,
      gather,
      passes: reviewerNames.map((name) => ({
        name, source: `/${name}.md`, body: 'Review carefully.', matchedBy: 'baseline' as const, matchedOn: [], baseline: true,
      })),
      indexEntries: [], stackTags: ['typescript'], installedCompanions: [], skipReviewers: [],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    const missing = new Set(reviewerNames.slice(18));
    let calls = 0;
    let firstHashes = new Map<string, string>();
    const prompts: string[] = [];

    const result = await runSingleSession(opts, ctx, async (args) => {
      calls++;
      prompts.push(args.promptBody);
      assert.equal(args.repoRoot, undefined, 'planned runtimes are confined to materialized run artifacts');
      if (calls === 1) {
        for (const [index, reviewer] of plan.reviewers.entries()) {
          if (missing.has(reviewer.name)) continue;
          writeFileSync(
            attemptOutputPath(reviewer, 1),
            JSON.stringify(index === 0
              ? [{ severity: 'HIGH', title: 'real risk', body: 'fix this', file: 'src/app.ts', line: 1 }]
              : []),
          );
        }
        assert.equal(existsSync(plan.phase1Path), false, 'partial delivery never creates Phase 1');
        return { stdout: 'DONE', stderr: '', exitCode: 0 };
      }
      if (calls === 2) {
        firstHashes = new Map(
          plan.reviewers.slice(0, 18).map((reviewer) => [reviewer.name, sha256File(reviewer.canonicalOutputPath)]),
        );
        for (const reviewer of plan.reviewers.filter((entry) => missing.has(entry.name))) {
          writeFileSync(attemptOutputPath(reviewer, 2), '[]');
        }
        assert.equal(existsSync(plan.phase1Path), false, 'recovery output is promoted before aggregation');
        return { stdout: 'DONE', stderr: '', exitCode: 0 };
      }
      assert.equal(calls, 3, 'the third and final runtime is the direct verifier');
      assert.ok(!args.promptBody.includes('task('), 'the verifier is the runtime session, not a nested task');
      writeFileSync(verifierAttemptOutputPath(plan.verifier, 1), '[]');
      return { stdout: '[]', stderr: '', exitCode: 0 };
    });

    assert.equal(calls, 3);
    assert.equal(result.findingsUnavailable, false);
    assert.equal(result.deliveryState?.kind, 'complete');
    assert.equal(result.deliveryState?.valid.length, 22);
    assert.equal(result.deliveryState?.verifier.state, 'valid');
    assert.deepEqual(
      plan.reviewers.slice(0, 18).map((reviewer) => sha256File(reviewer.canonicalOutputPath)),
      plan.reviewers.slice(0, 18).map((reviewer) => firstHashes.get(reviewer.name)),
      'the automatic recovery does not touch already-valid sidecars',
    );
    for (const name of reviewerNames.slice(0, 18)) assert.ok(!prompts[1]!.includes('record as reviewer name `' + name + '`'));
    for (const name of reviewerNames.slice(18)) assert.ok(prompts[1]!.includes('record as reviewer name `' + name + '`'));
    const phase1 = JSON.parse(readFileSync(plan.phase1Path, 'utf8')) as { reviewers: Array<{ name: string }> };
    const consolidated = JSON.parse(readFileSync(plan.findingsPath, 'utf8')) as { reviewers: Array<{ name: string }> };
    assert.deepEqual(phase1.reviewers.map((reviewer) => reviewer.name), reviewerNames);
    assert.deepEqual(consolidated.reviewers.map((reviewer) => reviewer.name), [...reviewerNames, 'verifier']);
    const events = readReviewerProgress(dir);
    const kinds = events.map((event) => event.kind);
    assert.ok(kinds.includes('session-attempt-started'));
    assert.ok(kinds.includes('output-first-seen'));
    assert.ok(kinds.includes('output-promoted'));
    assert.ok(kinds.includes('recovery-started'));
    assert.ok(kinds.includes('recovery-completed'));
    assert.ok(kinds.includes('phase1-assembled'));
    assert.ok(kinds.includes('verifier-started'));
    assert.ok(kinds.includes('verifier-completed'));
    assert.ok(kinds.includes('consolidated-assembled'));
    assert.equal(events.filter((event) => event.kind === 'output-promoted').length, 22);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — selective recovery rejects mutation of an already-valid canonical sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-planned-tamper-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: {
        title: 'Test PR', description: 'A complete description.', author: 'tester',
        headSha: 'abcdef', baseSha: '123456', baseBranch: 'main', headBranch: 'feature',
        labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const,
      },
      changedFiles: [{ path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-old\n+new' }],
      existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: ['valid', 'missing'].map((name) => ({
        name, source: `/${name}.md`, body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true,
      })),
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: [],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    let calls = 0;
    await assert.rejects(
      runSingleSession(opts, ctx, async () => {
        calls++;
        if (calls === 1) {
          writeFileSync(attemptOutputPath(ctx.dispatchPlan!.reviewers[0]!, 1), '[]');
        } else {
          writeFileSync(ctx.dispatchPlan!.reviewers[0]!.canonicalOutputPath, JSON.stringify([
            { severity: 'HIGH', title: 'forged', body: 'forged', file: 'src/app.ts', line: 1 },
          ]));
          writeFileSync(attemptOutputPath(ctx.dispatchPlan!.reviewers[1]!, 2), '[]');
        }
        return { stdout: 'DONE', stderr: '', exitCode: 0 };
      }),
      /delivery artifact integrity failure.*canonical reviewer output changed: valid/,
    );
    assert.equal(calls, 2);
    assert.equal(existsSync(ctx.phase1Path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — enabled Codex reserves attempt 1 before reviewer dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-codex-reserve-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-codex-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete description', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = { prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, controlDir, includeCodex: true, invokeCompanions: false, runtime: 'copilot' as const };
    const ctx = prepareSessionContext(opts);
    const result = await runSingleSession(opts, ctx, async () => {
      const state = JSON.parse(readFileSync(ctx.deliveryStatePath!, 'utf8')) as { codex: { attempts: number; state: string } };
      assert.deepEqual(state.codex, { state: 'pending', attempts: 1 });
      writeFileSync(attemptOutputPath(ctx.dispatchPlan!.reviewers[0]!, 1), '[]');
      return { stdout: 'DONE', stderr: '', exitCode: 0 };
    });
    assert.equal(result.deliveryState?.codex.attempts, 1);
    assert.equal(result.findingsUnavailable, true, 'pending Codex coverage keeps delivery incomplete');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('resumePlannedSession — matching reserved provisional re-binds a canonical promoted before state persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-promotion-crash-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-promotion-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete description', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const ctx = prepareSessionContext({ prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' });
    const plan = ctx.dispatchPlan!;
    writeFileSync(attemptOutputPath(plan.reviewers[0]!, 1), '[]');
    const state = createDeliveryState(plan, inspectReviewerDelivery({ one: plan.reviewers[0]!.canonicalOutputPath }, plan.model, 0));
    state.reviewerAttempts.one = 1;
    writeDeliveryState(state, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!);
    promoteReviewerAttempt(plan.reviewers[0]!, 1, plan.model, 0);
    const result = await resumePlannedSession(plan, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!, async () => {
      throw new Error('must not re-dispatch');
    });
    assert.equal(result.findingsUnavailable, false);
    assert.equal(result.deliveryState?.reviewerDigests.one, sha256File(plan.reviewers[0]!.canonicalOutputPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('resumePlannedSession — forged verifier canonical without reserved attempt is rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-verifier-forge-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-verifier-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete description', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const ctx = prepareSessionContext({ prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: [], outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' });
    const plan = ctx.dispatchPlan!;
    writeFileSync(plan.reviewers[0]!.canonicalOutputPath, JSON.stringify([{ severity: 'HIGH', title: 'x', body: 'x', file: 'a.ts', line: 1 }]));
    const inventory = inspectReviewerDelivery({ one: plan.reviewers[0]!.canonicalOutputPath }, plan.model, 0);
    const state = createDeliveryState(plan, inventory);
    state.reviewerDigests.one = sha256File(plan.reviewers[0]!.canonicalOutputPath);
    writeDeliveryState(state, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!);
    writeFileSync(plan.verifier.canonicalOutputPath!, '[]');
    await assert.rejects(
      resumePlannedSession(plan, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!, async () => { throw new Error('must not spawn'); }),
      /unbound canonical verifier output/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});
