import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  attemptOutputPath,
  createDispatchPlan,
  readAuthoritativeDeliveryState,
  verifierAttemptOutputPath,
  writeDispatchPlan,
} from '../src/dispatch/delivery.js';
import { sha256File } from '../src/util/atomic-json.js';
import { readReviewerProgress } from '../src/dispatch/reviewer-progress.js';
import { createDeliveryState, inspectReviewerDelivery, promoteReviewerAttempt, writeDeliveryState } from '../src/dispatch/delivery.js';
import { runtimeTaskName } from '../src/dispatch/runtime.js';

// spawnRuntime's resolved shape — the seam the fake must satisfy.
type SpawnResult = { stdout: string; stderr: string; exitCode: number };
type FakeSpawn = () => Promise<SpawnResult>;

const RATE_LIMIT = 'Server is temporarily limiting requests · Rate limited';
const findingsJson = (body: string) =>
  JSON.stringify({ reviewers: [{ name: 'quality', findings: [{ severity: 'MEDIUM', title: 't', body, file: 'a.ts', line: 1 }] }] });

function copilotJsonl(
  results: Array<{ reviewer: string; content: string; success?: boolean }>,
  resolvedModel?: string,
): string {
  const events: unknown[] = [];
  if (resolvedModel) events.push({ type: 'session.auto_mode_resolved', data: { chosenModel: resolvedModel } });
  for (const [index, result] of results.entries()) {
    const toolCallId = `call-${index}`;
    events.push({
      type: 'tool.execution_start',
      data: {
        toolCallId,
        toolName: 'task',
        arguments: {
          name: runtimeTaskName(result.reviewer),
          agent_type: 'general-purpose',
          prompt: 'review',
          description: 'Review',
          mode: 'sync',
        },
      },
    });
    events.push({
      type: 'tool.execution_complete',
      data: {
        toolCallId,
        success: result.success ?? true,
        result: { content: result.content },
      },
    });
  }
  return events.map((event) => JSON.stringify(event)).join('\n');
}

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
        return { stdout: copilotJsonl([], 'gpt-5.6-luna'), stderr: '', exitCode: 0 };
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

test('runSingleSession — Copilot JSONL adopts only a missing attempt sidecar and records its resolved model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-jsonl-adoption-'));
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
      passes: ['written', 'returned'].map((name) => ({
        name, source: `/${name}.md`, body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true,
      })),
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    const returnedFindings = '[{"severity":"MEDIUM","title":"returned finding","body":"preserve exact bytes","file":"src/app.ts","line":1}]';

    const result = await runSingleSession(opts, ctx, async (args) => {
      assert.equal(args.model, 'auto');
      writeFileSync(attemptOutputPath(plan.reviewers[0]!, 1), '[]');
      return {
        stdout: copilotJsonl([
          { reviewer: 'written', content: '[{"severity":"HIGH","title":"must not replace","body":"must not replace","file":"src/app.ts","line":1}]' },
          { reviewer: 'returned', content: returnedFindings },
        ], 'gpt-5.6-luna'),
        stderr: '', exitCode: 0,
      };
    });

    assert.equal(result.findingsUnavailable, false);
    assert.equal(readFileSync(attemptOutputPath(plan.reviewers[0]!, 1), 'utf8'), '[]');
    assert.equal(readFileSync(attemptOutputPath(plan.reviewers[1]!, 1), 'utf8'), returnedFindings);
    assert.equal(readFileSync(plan.reviewers[1]!.canonicalOutputPath, 'utf8'), returnedFindings);
    assert.equal(result.outputs.find((output) => output.reviewerName === 'returned')?.findings[0]?.body, 'preserve exact bytes');
    assert.equal(result.deliveryState?.runtimeAttempts[0]?.requestedModel, 'auto');
    assert.equal(result.deliveryState?.runtimeAttempts[0]?.resolvedModel, 'gpt-5.6-luna');
    const adopted = readReviewerProgress(dir).find((event) =>
      event.kind === 'output-adopted' && event.reviewer === 'returned');
    assert.equal(adopted?.attempt, 1);
    assert.match(adopted?.detail ?? '', /copilot-jsonl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — JSONL adoption I/O failure preserves the completed launch and valid primary sidecars', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-jsonl-adoption-io-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: ['written', 'returned'].map((name) => ({
        name, source: `/${name}`, body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true,
      })),
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    const written = plan.reviewers[0]!;
    const returned = plan.reviewers[1]!;
    rmSync(returned.attemptsDir, { recursive: true, force: true });
    writeFileSync(returned.attemptsDir, 'not a directory', 'utf8');
    const models: string[] = [];
    let calls = 0;

    const result = await runSingleSession(opts, ctx, async (args) => {
      calls++;
      models.push(args.model);
      if (calls === 1) {
        writeFileSync(attemptOutputPath(written, 1), '[]', 'utf8');
        return {
          stdout: copilotJsonl([{ reviewer: 'returned', content: '[]' }], 'gpt-5.6-luna'),
          stderr: '', exitCode: 0,
        };
      }
      rmSync(returned.attemptsDir, { force: true });
      mkdirSync(returned.attemptsDir, { recursive: true });
      writeFileSync(attemptOutputPath(returned, 2), '[]', 'utf8');
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    assert.equal(calls, 2);
    assert.deepEqual(models, ['auto', 'gpt-5.6-luna']);
    assert.equal(result.findingsUnavailable, false);
    assert.equal(result.deliveryState?.runtimeAttempts[0]?.status, 'completed');
    assert.equal(result.deliveryState?.runtimeAttempts[0]?.resolvedModel, 'gpt-5.6-luna');
    assert.deepEqual(result.deliveryState?.runtimeAttempts[0]?.adoptedReviewers, []);
    assert.match(result.deliveryState?.runtimeAttempts[0]?.runtimeError ?? '', /structured result adoption failed for returned/i);
    assert.deepEqual(result.outputs.map((output) => output.reviewerName), ['written', 'returned']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — reverse-order Copilot completions adopt the matching reviewer outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-jsonl-order-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: ['alpha', 'beta'].map((name) => ({
        name, source: `/${name}`, body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true,
      })),
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    const alpha = '[{"severity":"MEDIUM","title":"alpha","body":"alpha body","file":"a.ts","line":1}]';
    const beta = '[{"severity":"HIGH","title":"beta","body":"beta body","file":"a.ts","line":1}]';
    const events = [
      { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna' } },
      { type: 'tool.execution_start', data: { toolCallId: 'call-alpha', toolName: 'task', arguments: { name: runtimeTaskName('alpha') } } },
      { type: 'tool.execution_start', data: { toolCallId: 'call-beta', toolName: 'task', arguments: { name: runtimeTaskName('beta') } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'call-beta', success: true, result: { content: beta } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'call-alpha', success: true, result: { content: alpha } } },
    ];

    const result = await runSingleSession(opts, ctx, async () => ({
      stdout: events.map((event) => JSON.stringify(event)).join('\n'), stderr: '', exitCode: 0,
    }));

    assert.equal(result.findingsUnavailable, false);
    assert.equal(readFileSync(plan.reviewers[0]!.canonicalOutputPath, 'utf8'), alpha);
    assert.equal(readFileSync(plan.reviewers[1]!.canonicalOutputPath, 'utf8'), beta);
    assert.deepEqual(result.deliveryState?.runtimeAttempts[0]?.adoptedReviewers, ['alpha', 'beta']);
    assert.equal(result.outputs.find((output) => output.reviewerName === 'alpha')?.findings[0]?.body, 'alpha body');
    assert.equal(result.outputs.find((output) => output.reviewerName === 'beta')?.findings[0]?.body, 'beta body');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — production Copilot spawn applies isolation and structured-output argv', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-real-spawn-'));
  try {
    const evidencePath = join(dir, 'spawn-evidence.json');
    const scriptPath = join(dir, 'fake-copilot.mjs');
    const taskName = runtimeTaskName('one');
    const events = copilotJsonl([{ reviewer: 'one', content: '[]' }], 'gpt-5.6-luna');
    writeFileSync(
      scriptPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `let input = '';`,
        `process.stdin.setEncoding('utf8');`,
        `process.stdin.on('data', (chunk) => { input += chunk; });`,
        `process.stdin.on('end', () => {`,
        `  writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ env: process.env.COPILOT_PLUGIN_DIR_ONLY, argv: process.argv.slice(2), input }));`,
        `  process.stdout.write(${JSON.stringify(events)});`,
        `});`,
      ].join('\n'),
      'utf8',
    );
    const binary = process.platform === 'win32'
      ? join(dir, 'fake-copilot.cmd')
      : join(dir, 'fake-copilot');
    if (process.platform === 'win32') {
      writeFileSync(binary, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    } else {
      writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
      chmodSync(binary, 0o755);
    }
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = { prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, invokeCompanions: false, runtime: 'copilot' as const, copilotBinary: binary };
    const ctx = prepareSessionContext(opts);

    const result = await runSingleSession(opts, ctx);
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as { env?: string; argv: string[]; input: string };

    assert.equal(result.findingsUnavailable, false);
    assert.equal(evidence.env, 'true');
    assert.ok(evidence.argv.includes('--excluded-tools=powershell,bash,shell'));
    assert.deepEqual(evidence.argv.slice(evidence.argv.indexOf('--output-format'), evidence.argv.indexOf('--output-format') + 4), [
      '--output-format', 'json', '--stream', 'off',
    ]);
    assert.ok(evidence.input.includes(`name=${JSON.stringify(taskName)}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — Copilot JSONL never replaces an existing invalid attempt sidecar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-jsonl-invalid-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = { prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, invokeCompanions: false, runtime: 'copilot' as const };
    const ctx = prepareSessionContext(opts);
    const reviewer = ctx.dispatchPlan!.reviewers[0]!;
    let calls = 0;

    const result = await runSingleSession(opts, ctx, async () => {
      calls++;
      const attempt = calls;
      writeFileSync(attemptOutputPath(reviewer, attempt), '{invalid');
      return { stdout: copilotJsonl([{ reviewer: 'one', content: '[]' }], calls === 1 ? 'gpt-5.6-luna' : undefined), stderr: '', exitCode: 0 };
    });

    assert.equal(calls, 2);
    assert.equal(result.findingsUnavailable, true);
    assert.equal(readFileSync(attemptOutputPath(reviewer, 2), 'utf8'), '{invalid');
    const progress = readReviewerProgress(dir);
    assert.ok(progress.some((event) => event.kind === 'output-invalid' && event.reviewer === 'one' && event.attempt === 2));
    assert.ok(!progress.some((event) => event.kind === 'output-adopted'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — automatic Copilot Auto recovery reuses the initial resolved model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-resolved-auto-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = { prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, invokeCompanions: false, runtime: 'copilot' as const };
    const ctx = prepareSessionContext(opts);
    const models: string[] = [];
    let calls = 0;

    const result = await runSingleSession(opts, ctx, async (args) => {
      calls++;
      models.push(args.model);
      if (calls === 1) {
        return { stdout: copilotJsonl([], 'gpt-5.6-luna'), stderr: '', exitCode: 0 };
      }
      writeFileSync(attemptOutputPath(ctx.dispatchPlan!.reviewers[0]!, 2), '[]');
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    assert.deepEqual(models, ['auto', 'gpt-5.6-luna']);
    assert.equal(result.findingsUnavailable, false);
    assert.deepEqual(result.deliveryState?.runtimeAttempts.map((attempt) => attempt.requestedModel), models);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — missing initial Auto resolution fails terminal without reserving recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-missing-auto-model-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = { prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, invokeCompanions: false, runtime: 'copilot' as const };
    const ctx = prepareSessionContext(opts);
    let calls = 0;

    const result = await runSingleSession(opts, ctx, async () => {
      calls++;
      return { stdout: JSON.stringify({ type: 'result', exitCode: 0 }), stderr: '', exitCode: 0 };
    });

    assert.equal(calls, 1);
    assert.equal(result.findingsUnavailable, true);
    assert.equal(result.deliveryState?.kind, 'terminal-incomplete');
    assert.deepEqual(result.deliveryState?.reasonCodes, ['auto-model-provenance-missing']);
    assert.equal(result.deliveryState?.reviewerAttempts.one, 1);
    assert.equal(result.deliveryState?.runtimeAttempts.length, 1);
    assert.ok(!readReviewerProgress(dir).some((event) => event.kind === 'recovery-started'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — complete Copilot Auto sidecars still require initial root-route provenance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-auto-route-required-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const,
    };
    const ctx = prepareSessionContext(opts);
    const result = await runSingleSession(opts, ctx, async () => {
      writeFileSync(attemptOutputPath(ctx.dispatchPlan!.reviewers[0]!, 1), '[]');
      return { stdout: JSON.stringify({ type: 'result', data: { exitCode: 0 } }), stderr: '', exitCode: 0 };
    });

    assert.equal(result.findingsUnavailable, true);
    assert.equal(result.deliveryState?.kind, 'terminal-incomplete');
    assert.deepEqual(result.deliveryState?.reasonCodes, ['auto-model-provenance-missing']);
    assert.equal(result.deliveryState?.runtimeAttempts[0]?.resolvedModel, undefined);
    assert.equal(existsSync(ctx.phase1Path), false);
    assert.equal(existsSync(ctx.findingsPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — unsafe spawn preflight does not reserve a phantom attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-spawn-preflight-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-spawn-preflight-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' as const, defaultModel: 'unsafe&model',
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;

    await assert.rejects(runSingleSession(opts, ctx), /runtime argument contains unsupported characters/);
    let state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.reviewerAttempts.one, 0);
    assert.deepEqual(state.runtimeAttempts, []);

    writeFileSync(attemptOutputPath(plan.reviewers[0]!, 1), '[]', 'utf8');
    await assert.rejects(
      resumePlannedSession(plan, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!),
      /runtime argument contains unsupported characters/,
    );
    state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.reviewerAttempts.one, 0);
    assert.deepEqual(state.runtimeAttempts, []);
    assert.equal(existsSync(plan.reviewers[0]!.canonicalOutputPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runSingleSession — synchronous spawn rejection cannot authorize a later forged attempt file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-spawn-rejected-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-spawn-rejected-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' as const, defaultModel: 'gpt-5.6-luna',
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    let spawns = 0;

    await assert.rejects(
      runSingleSession(opts, ctx, () => {
        spawns++;
        throw new Error('synchronous spawn rejection');
      }),
      /synchronous spawn rejection/,
    );
    let state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.reviewerAttempts.one, 1);
    assert.equal(state.runtimeAttempts.length, 1);
    assert.equal(state.runtimeAttempts[0]?.status, 'spawn-rejected');
    assert.deepEqual(state.runtimeAttempts[0]?.adoptedReviewers, []);

    const forged = '[{"severity":"HIGH","title":"forged","body":"must not be adopted","file":"a.ts","line":1}]';
    writeFileSync(attemptOutputPath(plan.reviewers[0]!, 1), forged, 'utf8');
    const result = await resumePlannedSession(
      plan,
      ctx.deliveryStatePath!,
      ctx.authoritativeDeliveryStatePath!,
      async () => {
        spawns++;
        writeFileSync(attemptOutputPath(plan.reviewers[0]!, 2), '[]', 'utf8');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    assert.equal(spawns, 2);
    assert.equal(result.findingsUnavailable, false);
    assert.deepEqual(result.outputs[0]?.findings, []);
    assert.equal(readFileSync(plan.reviewers[0]!.canonicalOutputPath, 'utf8'), '[]');
    state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.reviewerAttempts.one, 2);
    assert.equal(state.runtimeAttempts[1]?.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('resumePlannedSession — final rejected reviewer attempt is terminal immediately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-spawn-exhausted-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-spawn-exhausted-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' as const, defaultModel: 'gpt-5.6-luna',
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    const reject = async () => { throw new Error('runtime unavailable'); };

    await assert.rejects(runSingleSession(opts, ctx, reject), /runtime unavailable/);
    await assert.rejects(
      resumePlannedSession(plan, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!, reject),
      /runtime unavailable/,
    );
    let state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.kind, 'recoverable-incomplete');

    await assert.rejects(
      resumePlannedSession(plan, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!, reject),
      /runtime unavailable/,
    );
    state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.reviewerAttempts.one, 3);
    assert.equal(state.kind, 'terminal-incomplete');
    assert.deepEqual(state.reasonCodes, ['attempts-exhausted', 'runtime-spawn-rejected']);
    assert.ok(state.runtimeAttempts.every((attempt) => attempt.status === 'spawn-rejected'));
    assert.ok(state.runtimeAttempts.every((attempt) => Array.isArray(attempt.adoptedReviewers)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runSingleSession — synchronous verifier rejection cannot authorize a forged verifier attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-verifier-rejected-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-verifier-rejected-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: [],
      outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' as const, defaultModel: 'gpt-5.6-luna',
    };
    const ctx = prepareSessionContext(opts);
    const plan = ctx.dispatchPlan!;
    let spawns = 0;

    await assert.rejects(
      runSingleSession(opts, ctx, (async () => {
        spawns++;
        if (spawns === 1) {
          writeFileSync(attemptOutputPath(plan.reviewers[0]!, 1), JSON.stringify([
            { severity: 'HIGH', title: 'real', body: 'requires verification', file: 'a.ts', line: 1 },
          ]));
          return { stdout: '', stderr: '', exitCode: 0 };
        }
        throw new Error('synchronous verifier spawn rejection');
      }) as never),
      /synchronous verifier spawn rejection/,
    );
    let state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.verifier.attempts, 1);
    assert.equal(state.runtimeAttempts.at(-1)?.kind, 'verifier');
    assert.equal(state.runtimeAttempts.at(-1)?.status, 'spawn-rejected');

    const forged = '[{"severity":"CRITICAL","title":"forged","body":"must not be adopted","file":"a.ts","line":1}]';
    writeFileSync(verifierAttemptOutputPath(plan.verifier, 1), forged, 'utf8');
    const result = await resumePlannedSession(
      plan,
      ctx.deliveryStatePath!,
      ctx.authoritativeDeliveryStatePath!,
      async () => {
        spawns++;
        writeFileSync(verifierAttemptOutputPath(plan.verifier, 2), '[]', 'utf8');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    );

    assert.equal(spawns, 3);
    assert.equal(result.findingsUnavailable, false);
    assert.equal(result.outputs.find((output) => output.reviewerName === 'verifier')?.rawOutput, '[]');
    assert.equal(readFileSync(plan.verifier.canonicalOutputPath!, 'utf8'), '[]');
    state = readAuthoritativeDeliveryState(ctx.authoritativeDeliveryStatePath!, plan);
    assert.equal(state.verifier.attempts, 2);
    assert.equal(state.runtimeAttempts.at(-1)?.status, 'completed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runSingleSession — malformed Copilot JSONL is recorded as bounded attempt diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-jsonl-diagnostic-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = { prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, invokeCompanions: false, runtime: 'copilot' as const };
    const ctx = prepareSessionContext(opts);
    const result = await runSingleSession(opts, ctx, async () => ({ stdout: '{broken', stderr: '', exitCode: 1 }));

    assert.equal(result.deliveryState?.kind, 'terminal-incomplete');
    const diagnostic = result.deliveryState?.runtimeAttempts[0]?.runtimeError ?? '';
    assert.match(diagnostic, /Copilot JSONL: line 1: invalid JSON/);
    assert.ok(diagnostic.length <= 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSingleSession — runtime diagnostics compose JSONL, structured error, and bounded stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-runtime-causes-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const opts = {
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, invokeCompanions: false, runtime: 'copilot' as const, defaultModel: 'gpt-5.6-luna',
    };
    const ctx = prepareSessionContext(opts);
    const githubToken = `ghp_${'A'.repeat(24)}`;
    const diagnosticValue = 'material-value-456';
    const result = await runSingleSession(opts, ctx, async () => ({
      stdout: [
        JSON.stringify({ type: 'session.error', data: { message: `advisor rejected auto mode token=${githubToken}` } }),
        '{broken',
      ].join('\n'),
      stderr: `transport reset clientSecret=${diagnosticValue}\u0000${'x'.repeat(2_000)}`,
      exitCode: 1,
    }));

    const diagnostic = result.deliveryState?.runtimeAttempts[0]?.runtimeError ?? '';
    assert.match(diagnostic, /advisor rejected auto mode/);
    assert.match(diagnostic, /Copilot JSONL: line 2: invalid JSON/);
    assert.match(diagnostic, /transport reset/);
    assert.match(diagnostic, /\[REDACTED\]/);
    assert.doesNotMatch(diagnostic, new RegExp(githubToken));
    assert.doesNotMatch(diagnostic, new RegExp(diagnosticValue));
    assert.doesNotMatch(diagnostic, /[\u0000-\u001f\u007f]/);
    assert.ok(diagnostic.length <= 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: 'explicit Copilot model', runtime: 'copilot' as const, defaultModel: 'gpt-5.6-luna', expected: 'gpt-5.6-luna' },
  { name: 'Claude default alias', runtime: 'claude' as const, defaultModel: undefined, expected: 'opus' },
]) {
  test(`runSingleSession — ${scenario.name} remains unchanged across automatic recovery`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-review-model-control-'));
    try {
      const gather = {
        pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
        metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
        changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
      };
      const opts = {
        prUrl: gather.pr.url, gather,
        passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline' as const, matchedOn: [], baseline: true }],
        indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir,
        invokeCompanions: false, runtime: scenario.runtime, defaultModel: scenario.defaultModel,
      };
      const ctx = prepareSessionContext(opts);
      const models: string[] = [];
      let calls = 0;
      const result = await runSingleSession(opts, ctx, async (args) => {
        calls++;
        models.push(args.model);
        if (calls === 2) writeFileSync(attemptOutputPath(ctx.dispatchPlan!.reviewers[0]!, 2), '[]');
        return { stdout: '', stderr: '', exitCode: 0 };
      });

      assert.deepEqual(models, [scenario.expected, scenario.expected]);
      assert.equal(result.findingsUnavailable, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('resumePlannedSession — manual Copilot Auto recovery reuses authenticated initial resolved model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-resolved-resume-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-resolved-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const ctx = prepareSessionContext({ prUrl: gather.pr.url, gather, passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true }], indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'], outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot' });
    const plan = ctx.dispatchPlan!;
    const state = createDeliveryState(plan, inspectReviewerDelivery({ one: plan.reviewers[0]!.canonicalOutputPath }, plan.model, 0));
    state.reviewerAttempts.one = 1;
    state.runtimeAttempts.push({
      number: 1, kind: 'initial', reviewers: ['one'], startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString(),
      exitCode: 0, timedOut: false, timeoutMs: plan.timeoutMs, durationMs: 1,
      requestedModel: 'auto', resolvedModel: 'gpt-5.6-luna',
    });
    writeDeliveryState(state, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!);

    const result = await resumePlannedSession(plan, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!, async (args) => {
      assert.equal(args.model, 'gpt-5.6-luna');
      writeFileSync(attemptOutputPath(plan.reviewers[0]!, 2), '[]');
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    assert.equal(result.findingsUnavailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('resumePlannedSession — legacy native companion plans cannot re-dispatch but complete output replays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-legacy-companion-'));
  const controlDir = mkdtempSync(join(tmpdir(), 'pr-review-legacy-companion-control-'));
  try {
    const gather = {
      pr: { provider: 'github' as const, url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
      metadata: { title: 'Test', description: 'complete', author: 'a', headSha: 'h', baseSha: 'b', baseBranch: 'main', headBranch: 'f', labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const },
      changedFiles: [{ path: 'a.ts', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n-a\n+b' }], existingComments: [], gatheredAt: '',
    };
    const ctx = prepareSessionContext({
      prUrl: gather.pr.url, gather,
      passes: [{ name: 'one', source: '/one', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true }],
      indexEntries: [], stackTags: [], installedCompanions: [], skipReviewers: ['verifier'],
      outDir: dir, controlDir, invokeCompanions: false, runtime: 'copilot', defaultModel: 'gpt-5.6-luna',
    });
    const current = ctx.dispatchPlan!;
    const { schemaVersion: _schemaVersion, fingerprint: _fingerprint, ...draft } = current;
    const legacy = createDispatchPlan({
      ...draft,
      reviewers: [{
        ...current.reviewers[0]!,
        name: 'companion:code-review',
        kind: 'companion-slash' as never,
        agentType: 'code-reviewer',
        promptTemplate: 'Invoke /code-review:code-review. {{PR_REVIEW_OUTPUT_PATH}}',
      }],
    });
    writeDispatchPlan(legacy, ctx.dispatchPlanPath!, ctx.authoritativeDispatchPlanPath!);
    const inventory = () => inspectReviewerDelivery(
      { 'companion:code-review': legacy.reviewers[0]!.canonicalOutputPath }, legacy.model, 0,
    );
    writeDeliveryState(
      createDeliveryState(legacy, inventory()),
      ctx.deliveryStatePath!,
      ctx.authoritativeDeliveryStatePath!,
    );
    let spawns = 0;

    await assert.rejects(
      resumePlannedSession(legacy, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!, async () => {
        spawns++;
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
      /legacy native companion.*cannot be re-dispatched/i,
    );
    assert.equal(spawns, 0);

    writeFileSync(legacy.reviewers[0]!.canonicalOutputPath, '[]', 'utf8');
    writeDeliveryState(
      createDeliveryState(legacy, inventory()),
      ctx.deliveryStatePath!,
      ctx.authoritativeDeliveryStatePath!,
    );
    const replay = await resumePlannedSession(
      legacy,
      ctx.deliveryStatePath!,
      ctx.authoritativeDeliveryStatePath!,
      async () => {
        spawns++;
        throw new Error('complete legacy output must replay without executing its native prompt');
      },
    );
    assert.equal(spawns, 0);
    assert.equal(replay.findingsUnavailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
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
        return { stdout: copilotJsonl([], 'gpt-5.6-luna'), stderr: '', exitCode: 0 };
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
        return {
          stdout: calls === 1 ? copilotJsonl([], 'gpt-5.6-luna') : 'DONE',
          stderr: '',
          exitCode: 0,
        };
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
    state.runtimeAttempts.push({
      number: 1,
      kind: 'initial',
      status: 'started',
      reviewers: ['one'],
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(0).toISOString(),
      exitCode: -1,
      timedOut: false,
      timeoutMs: plan.timeoutMs,
      durationMs: 0,
      requestedModel: plan.model,
      resolvedModel: 'gpt-5.6-luna',
    });
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
