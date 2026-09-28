import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { controlDirForRun, ERROR_FILE, RUNS_ROOT } from '../src/util/tmp.js';
import { runStatus, statusExitCode } from '../src/commands/status.js';
import type { ReapDeps } from '../src/util/spawn.js';
import { runtimeSpawnArgs } from '../src/dispatch/runtime.js';
import { DEAD_PID, gone, idleRuntime } from './idle-runtime.js';
import {
  createDispatchPlan,
  readAuthoritativeDispatchPlan,
  writeFinalizationRecord,
  writeDeliveryState,
  writeDispatchPlan,
  type DeliveryState,
} from '../src/dispatch/delivery.js';
import { sha256File } from '../src/util/atomic-json.js';
import { writePostedMarker } from '../src/util/posted-marker.js';

// Most runs below are dead with a plan and no summary, so status sweeps them.
// They test status, not the sweep: an empty table keeps the host out of it.
const NO_HOST: ReapDeps = { table: () => [], killPid: () => 'no kill in this test' };

// status resolves run-id → RUNS_ROOT/<id>; seed test dirs there and clean up.
function seed(id: string): string {
  const dir = join(RUNS_ROOT, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function deliveryState(kind: 'running' | 'complete' | 'recoverable-incomplete' | 'terminal-incomplete') {
  return {
    schemaVersion: 1,
    planFingerprint: 'f',
    updatedAt: new Date(0).toISOString(),
    kind,
    planned: Array.from({ length: 22 }, (_, index) => `reviewer-${index}`),
    valid: Array.from({ length: 18 }, (_, index) => `reviewer-${index}`),
    missing: ['reviewer-18', 'reviewer-19', 'reviewer-20', 'reviewer-21'],
    invalid: [],
    recoveredFindingCount: 14,
    severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 3, LOW: 4, NIT: 6 },
    reviewerAttempts: {},
    reviewerDigests: {},
    runtimeAttempts: [],
    phase1: 'missing',
    consolidated: 'missing',
    verifier: { state: 'required', attempts: 0 },
    codex: { state: 'disabled', attempts: 0 },
    reasonCodes: kind === 'terminal-incomplete' ? ['attempts-exhausted'] : ['reviewer-delivery-incomplete'],
  };
}

function seedRecoveryAuthority(dir: string, state: ReturnType<typeof deliveryState>): string {
  const controlDir = controlDirForRun(dir);
  const plan = createDispatchPlan({
    runId: idFromDir(dir),
    runDir: dir,
    createdAt: new Date(0).toISOString(),
    pr: { provider: 'github', url: 'u', owner: 'o', repo: 'r', number: 1 },
    metadata: { headSha: 'h', baseSha: 'b', headBranch: 'f', baseBranch: 'main', state: 'open', isDraft: false },
    runtime: 'copilot',
    runtimeBinary: 'copilot',
    disabledMcpServers: [],
    model: 'm',
    timeoutMs: 1,
    phase1Path: join(dir, 'phase1-findings.json'),
    findingsPath: join(dir, 'single-session-findings.json'),
    execution: { dryRun: true, publish: false, dedupeMode: 'strict' },
    configProjection: {},
    configFingerprint: 'unused-by-status',
    artifacts: [],
    reviewers: [],
    verifier: { enabled: false, maxAttempts: 3 },
    codex: { enabled: false, contextPath: join(dir, 'pr-context.md'), attemptsDir: join(dir, 'codex-attempts'), maxAttempts: 3 },
  });
  state.planFingerprint = plan.fingerprint;
  writeDispatchPlan(plan, join(dir, 'dispatch-plan.json'), join(controlDir, 'dispatch-plan.json'));
  writeDeliveryState(state as DeliveryState, join(dir, 'delivery-state.json'), join(controlDir, 'delivery-state.json'));
  return controlDir;
}

function seedFinalizedAuthority(
  dir: string,
  state: ReturnType<typeof deliveryState>,
  exitCode: 0 | 1 | 2,
): string {
  const controlDir = seedRecoveryAuthority(dir, state);
  const plan = readAuthoritativeDispatchPlan(join(controlDir, 'dispatch-plan.json'));
  const summaryPath = join(dir, 'pr-review-summary.md');
  const findingsPath = join(dir, 'pr-review-findings.json');
  writeFileSync(summaryPath, `# signed summary ${exitCode}`, 'utf8');
  writeFileSync(findingsPath, '{"finalFindings":[]}', 'utf8');
  writeFinalizationRecord(dir, undefined, {
    schemaVersion: 1,
    planFingerprint: plan.fingerprint,
    execution: { dryRun: true, publish: false },
    completedAt: new Date(0).toISOString(),
    exitCode,
    summaryPath,
    summaryDigest: sha256File(summaryPath),
    findingsPath,
    findingsDigest: sha256File(findingsPath),
  });
  return controlDir;
}

function idFromDir(dir: string): string {
  return dir.split(/[\\/]/).pop()!;
}

test('runStatus — a promoted zero-eligible run never advertises a dry-run demotion', () => {
  const id = 'status-publication-promotion';
  const dir = seed(id);
  const controlDir = seedRecoveryAuthority(dir, deliveryState('complete'));
  try {
    const plan = readAuthoritativeDispatchPlan(join(controlDir, 'dispatch-plan.json'));
    writePostedMarker(dir, { posted: 0, attempted: 0, verified: true, confirmedKeys: [], planFingerprint: plan.fingerprint });
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'interrupted');
    assert.match(result.text, /--resume/);
    assert.doesNotMatch(result.text, /--dry-run/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — done when the summary is on disk (text IS the summary)', () => {
  const id = 'status-test-done';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'pr-review-summary.md'), '# PR Review Summary\n\nbody', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'done');
    assert.match(r.text, /PR Review Summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — a live pid reports running even with an intermediate phase1 artifact present', () => {
  const id = 'status-test-alive';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(process.pid), 'utf8'); // this test process is alive
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'running', 'a healthy run mid-flight must not read as interrupted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — a dead pid with reviewer output → interrupted (resume it)', () => {
  const id = 'status-test-interrupted';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    writeFileSync(join(dir, 'pr-review-gather.json'), '{"pr":{"url":"https://example.test/o/r/pull/1"}}', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'interrupted');
    assert.match(r.text, /pr-review review 'https:\/\/example\.test\/o\/r\/pull\/1'/);
    assert.doesNotMatch(r.text, /<pr-url>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — a corrupt findings file reads failed (error.txt inline), never a dead-end interrupted', () => {
  const id = 'status-test-corrupt-findings';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    // The orchestrator-flake class: a truncated final write left unparseable JSON.
    writeFileSync(join(dir, 'single-session-findings.json'), '{"reviewers":[{"name":"qual', 'utf8');
    writeFileSync(join(dir, ERROR_FILE), 'pipeline failure: NOT a clean PR\n', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'failed', 'resume cannot load this file — interrupted would hint a dead-end --resume');
    assert.match(r.text, /NOT a clean PR/, 'the recorded error must surface');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — corrupt final file but a valid phase1 fallback → interrupted (resume genuinely works)', () => {
  const id = 'status-test-corrupt-with-phase1';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'single-session-findings.json'), '{"reviewers":[{"na', 'utf8');
    writeFileSync(join(dir, 'phase1-findings.json'), '{"reviewers":[]}', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'interrupted', 'resumeReview falls back to phase1 — the hint is honest here');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — a dead pid with no findings → failed (poller can stop)', () => {
  const id = 'status-test-failed';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '' }) + '\n', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'failed');
    assert.match(r.text, /detached\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — failed run with error.txt surfaces the recorded error inline', () => {
  const id = 'status-test-failed-error';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '' }) + '\n', 'utf8');
    writeFileSync(join(dir, ERROR_FILE), 'Error: boom\n  at gather (x.ts:1)\n', 'utf8');
    const r = runStatus(id, undefined, NO_HOST);
    assert.equal(r.state, 'failed');
    assert.match(r.text, /Error: boom/, 'recorded fatal error is inlined');
    assert.match(r.text, /detached\.log/, 'log pointer still present alongside the inline error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — no run.pid + only a progress feed → running (unknown liveness, keep polling)', () => {
  const id = 'status-test-nopid';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'progress.ndjson'), JSON.stringify({ ts: 1, phase: 'gather', detail: '3 files' }) + '\n', 'utf8');
    const r = runStatus(id, 61_000, NO_HOST);
    assert.equal(r.state, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — live schema-v1 run shows reviewer and finding counts', () => {
  const id = 'status-test-delivery-live';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(process.pid), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(deliveryState('running')), 'utf8');
    writeFileSync(join(dir, 'pr-review-summary.md'), 'forged early summary', 'utf8');
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'running');
    assert.match(result.text, /reviewers 18\/22/);
    assert.match(result.text, /14 findings/);
    assert.match(result.text, /4 missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — dead authenticated running state is interrupted for crash recovery', () => {
  const id = 'status-test-delivery-crashed-running';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('running');
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(state), 'utf8');
    writeFileSync(join(dir, 'pr-review-summary.md'), 'forged early summary', 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'interrupted');
    assert.doesNotMatch(result.text, /forged early summary/);
    assert.doesNotMatch(result.text, /<pr-url>/);
    assert.match(result.text, /pr-review review 'u'/);
    assert.match(result.text, new RegExp(`--resume '${id}' --dry-run`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — authenticated complete delivery without summary resumes finalization despite stale error', () => {
  const id = 'status-test-delivery-complete-unfinalized';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('complete');
    state.valid = [...state.planned];
    state.missing = [];
    state.verifier = { state: 'skipped-no-severe', attempts: 0 };
    state.reasonCodes = [];
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(state), 'utf8');
    writeFileSync(join(dir, ERROR_FILE), 'stale incomplete-delivery error', 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'interrupted');
    assert.equal(statusExitCode(result.state), 21);
    assert.match(result.text, /Delivery is complete, but finalization stopped/);
    assert.doesNotMatch(result.text, /<pr-url>/);
    assert.match(result.text, /pr-review review 'u'/);
    assert.match(result.text, new RegExp(`--resume '${id}' --dry-run`));
    assert.doesNotMatch(result.text, /stale incomplete-delivery error/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — forged summary cannot complete schema-v1 without finalization authority', () => {
  const id = 'status-test-forged-summary-no-finalization';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('complete');
    state.valid = [...state.planned];
    state.missing = [];
    state.verifier = { state: 'skipped-no-severe', attempts: 0 };
    state.reasonCodes = [];
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(state), 'utf8');
    writeFileSync(join(dir, 'pr-review-summary.md'), '# forged runtime summary', 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'interrupted');
    assert.equal(statusExitCode(result.state), 21);
    assert.doesNotMatch(result.text, /forged runtime summary/);
    assert.match(result.text, /authenticated finalization is absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

for (const terminal of [
  { exitCode: 0 as const, expectedState: 'done' as const },
  { exitCode: 2 as const, expectedState: 'failed' as const },
]) {
  test(`runStatus — authenticated finalization exit ${terminal.exitCode} outranks forged error.txt`, () => {
    const id = `status-test-finalization-over-error-${terminal.exitCode}`;
    const dir = seed(id);
    let controlDir = '';
    try {
      const state = deliveryState('complete');
      state.valid = [...state.planned];
      state.missing = [];
      state.verifier = { state: 'skipped-no-severe', attempts: 0 };
      state.reasonCodes = [];
      writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
      controlDir = seedFinalizedAuthority(dir, state, terminal.exitCode);
      writeFileSync(join(dir, ERROR_FILE), 'forged untrusted failure', 'utf8');
      const result = runStatus(id, undefined, NO_HOST);
      assert.equal(result.state, terminal.expectedState);
      assert.match(result.text, new RegExp(`signed summary ${terminal.exitCode}`));
      assert.doesNotMatch(result.text, /forged untrusted failure/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (controlDir) rmSync(controlDir, { recursive: true, force: true });
    }
  });
}

test('runStatus — recoverable schema-v1 delivery is interrupted even when error.txt exists', () => {
  const id = 'status-test-delivery-recoverable';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('recoverable-incomplete');
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(state), 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);
    writeFileSync(join(dir, ERROR_FILE), 'incomplete delivery', 'utf8');
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'interrupted');
    assert.equal(statusExitCode(result.state), 21);
    assert.match(result.text, /reviewers 18\/22/);
    assert.match(result.text, /re-dispatches only unresolved reviewers/);
    assert.match(result.text, /not accepted or posted/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — a recoverable mirror without control authority never advertises resume', () => {
  const id = 'status-test-delivery-no-authority';
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(deliveryState('recoverable-incomplete')), 'utf8');
    writeFileSync(join(dir, ERROR_FILE), 'control record unavailable', 'utf8');
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'failed');
    assert.doesNotMatch(result.text, /re-dispatches only unresolved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — incomplete v1 authority cannot fall back to a forged done summary', () => {
  const id = 'status-test-delivery-incomplete-authority';
  const dir = seed(id);
  const controlDir = controlDirForRun(dir);
  try {
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(join(controlDir, 'dispatch-plan.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'pr-review-summary.md'), '# forged done', 'utf8');
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'failed');
    assert.match(result.text, /unreadable or failed authentication/);
    assert.doesNotMatch(result.text, /forged done/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — terminal schema-v1 delivery remains failed', () => {
  const id = 'status-test-delivery-terminal';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('terminal-incomplete');
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify(state), 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);
    writeFileSync(join(dir, ERROR_FILE), 'stale advice: use --resume', 'utf8');
    const result = runStatus(id, undefined, NO_HOST);
    assert.equal(result.state, 'failed');
    assert.equal(statusExitCode(result.state), 22);
    assert.match(result.text, /attempts-exhausted/);
    assert.ok(result.text.indexOf('attempts-exhausted') < result.text.indexOf('stale advice'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — terminal delivery surfaces authenticated runtime cause and model provenance', () => {
  const id = 'status-test-runtime-cause';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('terminal-incomplete');
    state.runtimeAttempts = [{
      number: 2,
      kind: 'automatic-recovery',
      reviewers: ['reviewer-18'],
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      exitCode: 1,
      timedOut: false,
      timeoutMs: 1000,
      durationMs: 1,
      requestedModel: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.4',
      runtimeError: 'Execution failed: 400 advisor tool is not supported',
    }];
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);
    writeFileSync(join(dir, 'delivery-state.json'), JSON.stringify({ ...state, runtimeAttempts: [] }), 'utf8');

    const result = runStatus(id, undefined, NO_HOST);

    assert.equal(result.state, 'failed');
    assert.match(result.text, /requested model gpt-5\.6-luna/);
    assert.match(result.text, /resolved model gpt-5\.4/);
    assert.match(result.text, /400 advisor tool is not supported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — the latest attempt remains primary when only an earlier attempt has a runtime error', () => {
  const id = 'status-test-latest-runtime-cause';
  const dir = seed(id);
  let controlDir = '';
  try {
    const state = deliveryState('terminal-incomplete');
    state.runtimeAttempts = [
      {
        number: 1, kind: 'initial', reviewers: ['reviewer-18'], startedAt: new Date(0).toISOString(), endedAt: new Date(1).toISOString(),
        exitCode: 1, timedOut: false, timeoutMs: 1000, durationMs: 1, requestedModel: 'auto', resolvedModel: 'gpt-5.6-luna',
        runtimeError: 'initial rate limit',
      },
      {
        number: 2, kind: 'automatic-recovery', reviewers: ['reviewer-18'], startedAt: new Date(2).toISOString(), endedAt: new Date(3).toISOString(),
        exitCode: 127, timedOut: false, timeoutMs: 1000, durationMs: 1, requestedModel: 'gpt-5.6-luna',
      },
    ];
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    controlDir = seedRecoveryAuthority(dir, state);

    const result = runStatus(id, undefined, NO_HOST);

    assert.match(result.text, /Runtime attempt 2 \(automatic-recovery\)/);
    assert.match(result.text, /exit 127/);
    assert.doesNotMatch(result.text, /initial rate limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
  }
});

test('runStatus — missing run dir', () => {
  assert.equal(runStatus('status-test-does-not-exist-zzz').state, 'missing');
});

test('statusExitCode — the codes the slash-command poll loop branches on', () => {
  assert.equal(statusExitCode('done'), 0);
  assert.equal(statusExitCode('missing'), 1);
  assert.equal(statusExitCode('running'), 20);
  assert.equal(statusExitCode('interrupted'), 21);
  assert.equal(statusExitCode('failed'), 22);
});

test('runStatus — INV-HYG-04: the orphaned runtime session of a dead run is killed, recorded and shown', async () => {
  const id = `test-status-reap-${process.pid}`;
  const dir = seed(id);
  try {
    // The run dir rides in argv exactly as the runtime's own argv carries it.
    const { child, pid } = await idleRuntime(dir, runtimeSpawnArgs('claude', 'm', dir));
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    writeFileSync(join(dir, 'dispatch-plan.json'), '{}', 'utf8'); // a runtime is only ever spawned after the plan
    writeFileSync(join(dir, 'progress.ndjson'), `${JSON.stringify({ ts: 1, phase: 'dispatch', detail: '6 reviewers' })}\n`, 'utf8');
    const r = runStatus(id);
    assert.ok(await gone(pid), `orphaned runtime ${pid} survived status`);
    // The root of the tree is the child spawnCli returned: the cmd.exe in front of it on win32.
    const line = new RegExp(`killed its orphaned runtime session \\(\\S+ pid ${child.pid}\\)`);
    assert.match(readFileSync(join(dir, 'progress.ndjson'), 'utf8'), line);
    assert.match(r.text, line, 'the poller was never shown what status did');
    // The headline still says where the run got to — on this poll and on every later one.
    assert.match(r.text, /^⏳ dispatch — 6 reviewers/);
    assert.match(runStatus(id).text, /^⏳ dispatch — 6 reviewers/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Deps that count process-table reads and kill nothing — for runs that must not be swept. */
function watching(): ReapDeps & { scans: number } {
  const deps = {
    scans: 0,
    table: () => {
      deps.scans++;
      return 'no table in this test';
    },
    killPid: () => 'no kill in this test',
  };
  return deps;
}

// Asserted on the table reads, not on a process staying alive: on POSIX a wrongly
// killed child of this process stays a zombie until the event loop reaps it, and
// `kill(pid, 0)` still succeeds on a zombie — a liveness check would pass anyway.
test('runStatus — INV-HYG-04: a finished run, or one that never planned a dispatch, is not scanned', () => {
  const id = `test-status-noreap-${process.pid}`;
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    const deps = watching();

    // No plan: nothing was ever dispatched from this run.
    runStatus(id, Date.now(), deps);
    assert.equal(deps.scans, 0, 'a run with no dispatch plan had its process table scanned');

    // A summary written after run.pid was claimed: the run finished, its sessions closed first.
    writeFileSync(join(dir, 'dispatch-plan.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'pr-review-summary.md'), '# done\n', 'utf8');
    runStatus(id, Date.now(), deps);
    assert.equal(deps.scans, 0, 'a finished run had its process table scanned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — INV-HYG-04: a summary older than run.pid does not spare a hard-killed resume', () => {
  const id = `test-status-resumed-${process.pid}`;
  const dir = seed(id);
  try {
    writeFileSync(join(dir, 'dispatch-plan.json'), '{}', 'utf8');
    // The first attempt failed operationally and still wrote its summary...
    writeFileSync(join(dir, 'pr-review-summary.md'), '# first attempt\n', 'utf8');
    const earlier = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'pr-review-summary.md'), earlier, earlier);
    // ...then a --resume re-claimed run.pid and was killed too hard to clean up.
    writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
    const deps = watching();
    runStatus(id, Date.now(), deps);
    assert.equal(deps.scans, 1, 'the sessions of a hard-killed resume were never looked for');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runStatus — INV-HYG-04: a run id that escapes the runs root is never swept', () => {
  const name = `test-status-escape-${process.pid}`;
  const inside = seed(name);
  const outside = join(dirname(RUNS_ROOT), name); // ~/.pr-review/<name>, beside runs/
  mkdirSync(outside, { recursive: true });
  try {
    for (const dir of [inside, outside]) {
      writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
      writeFileSync(join(dir, 'dispatch-plan.json'), '{}', 'utf8');
    }
    // Control: the same run inside the root is swept.
    const control = watching();
    runStatus(name, Date.now(), control);
    assert.equal(control.scans, 1);

    const deps = watching();
    runStatus(`../${name}`, Date.now(), deps);
    assert.equal(deps.scans, 0, 'status swept a directory outside the runs root');
  } finally {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
