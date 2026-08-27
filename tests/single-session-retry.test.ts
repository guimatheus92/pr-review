import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTransientOrchestratorFailure,
  runSingleSession,
  type SessionContext,
  type SingleSessionOptions,
} from '../src/dispatch/single-session.js';

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
