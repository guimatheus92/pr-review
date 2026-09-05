import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ERROR_FILE, RUNS_ROOT } from '../src/util/tmp.js';
import { finalizeReview, writeOrchestratorFailureLog } from '../src/commands/review.js';
import { runStatus } from '../src/commands/status.js';
import { readProgress } from '../src/util/progress.js';
import type { Finding, PrRef, ReviewerOutput } from '../src/types.js';
import type { BatchComment, PrProvider } from '../src/providers/types.js';

const PATCH = ['@@ -10,4 +10,5 @@', ' c10', '-old11', '+new11', '+new12', ' c13'].join('\n');

function gatherFixture() {
  return {
    pr: { provider: 'github' as const, url: 'u', owner: 'o', repo: 'r', number: 1 },
    metadata: {
      title: 't', description: 'a real description of the change', author: 'a',
      headSha: 'sha1234567890', baseSha: 'sha0', baseBranch: 'main', headBranch: 'f',
      labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const,
    },
    changedFiles: [{ path: 'src/a.ts', status: 'modified' as const, additions: 2, deletions: 1, patch: PATCH }],
    existingComments: [], gatheredAt: '',
  };
}

function fakeProvider() {
  const calls = { batches: [] as BatchComment[][] };
  const provider: PrProvider = {
    name: 'github',
    parseUrl: (url: string): PrRef => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchExistingComments: async () => [],
    postLineComment: async () => ({ id: 'x' }),
    postBatchComments: async (_ref, _sha, comments) => {
      calls.batches.push(comments);
      return { posted: comments.length };
    },
  };
  return { provider, calls };
}

function failingPostProvider(readFails: boolean): PrProvider {
  return {
    name: 'github',
    parseUrl: (url: string): PrRef => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchExistingComments: async () => {
      if (readFails) throw new Error('read-back unavailable');
      return [];
    },
    isTransientError: () => false,
    postLineComment: async () => {
      throw new Error('write rejected');
    },
  };
}

// Seed under RUNS_ROOT with a dead pid so runStatus can be asserted directly.
const DEAD_PID = 2147483646;
function seedRun(id: string): string {
  mkdirSync(RUNS_ROOT, { recursive: true });
  const dir = mkdtempSync(join(RUNS_ROOT, `${id}-`));
  writeFileSync(join(dir, 'run.pid'), String(DEAD_PID), 'utf8');
  return dir;
}

test('finalizeReview — a pipeline failure never mints the done artifacts; status reports failed', async () => {
  const id = 'finalize-failure-test';
  const dir = seedRun(id);
  try {
    const r = await finalizeReview({
      prUrl: 'u',
      outDir: dir,
      gather: gatherFixture(),
      outputs: [],
      dedupeMode: 'strict',
      publish: false,
      dryRun: true,
      findingsUnavailable: true,
      overallStart: Date.now(),
    });
    assert.equal(r.exitCode, 2, 'no parseable findings is never a clean PR');
    assert.ok(!existsSync(join(dir, 'pr-review-summary.md')), 'summary is the done-state artifact — must not exist');
    assert.ok(!existsSync(join(dir, 'pr-review-findings.json')), 'findings artifact must not exist');
    assert.match(r.summary, /NOT a clean PR/);

    const errTxt = readFileSync(join(dir, ERROR_FILE), 'utf8');
    assert.match(errTxt, /NOT a clean PR/);
    assert.match(errTxt, /orchestrator-failure\.log/);

    const phases = readProgress(dir).map((e) => e.phase);
    assert.ok(phases.includes('error'), 'terminal progress event is error');
    assert.ok(!phases.includes('done'), 'a failed run must not emit done');

    const s = runStatus(basename(dir));
    assert.equal(s.state, 'failed', 'status must not read the failure as a clean review');
    assert.match(s.text, /NOT a clean PR/, 'the recorded error is surfaced inline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeOrchestratorFailureLog — persists the ENTIRE stdout/stderr, never a tail', () => {
  const id = 'finalize-failure-log-test';
  const dir = seedRun(id);
  try {
    // Well past the old 8 KB tail: the head marker must survive in the log.
    const stdout = 'HEAD-OF-STDOUT ' + 'x'.repeat(20_000) + ' TAIL-OF-STDOUT';
    const stderr = 'HEAD-OF-STDERR ' + 'y'.repeat(20_000) + ' TAIL-OF-STDERR';
    writeOrchestratorFailureLog(dir, 0, stdout, stderr);
    const log = readFileSync(join(dir, 'orchestrator-failure.log'), 'utf8');
    assert.ok(log.includes(stdout), 'full stdout must be present (head included)');
    assert.ok(log.includes(stderr), 'full stderr must be present (head included)');
    assert.match(log, /exitCode=0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizeReview — codex sibling findings never post when reviewer delivery is incomplete', async () => {
  const id = 'finalize-failure-codex-test';
  const dir = seedRun(id);
  try {
    const codexFinding: Finding = { severity: 'HIGH', title: 'x', body: 'a real finding body', file: 'src/a.ts', line: 11 };
    const outputs: ReviewerOutput[] = [
      { reviewerName: 'codex', model: 'codex', findings: [codexFinding], rawOutput: '', durationMs: 0, exitCode: 0 },
    ];
    const { provider, calls } = fakeProvider();
    const r = await finalizeReview({
      prUrl: 'u',
      outDir: dir,
      gather: gatherFixture(),
      outputs,
      dedupeMode: 'strict',
      publish: true,
      findingsUnavailable: true,
      overallStart: Date.now(),
      provider,
    });
    assert.equal(calls.batches.length, 0, 'partial coverage must fail before invoking the provider');
    assert.equal(r.exitCode, 2, 'a sibling pass is not a complete review');
    assert.ok(!existsSync(join(dir, 'pr-review-summary.md')), 'still no done-state artifact');
    assert.ok(!existsSync(join(dir, 'posted.marker')), 'no post attempt means no posting marker');
    assert.ok(existsSync(join(dir, ERROR_FILE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizeReview — concurrent finalizers reach the provider only once', async () => {
  const id = 'finalize-concurrency-test';
  const dir = seedRun(id);
  const home = mkdtempSync(join(tmpdir(), 'finalize-concurrency-home-'));
  let releasePost!: () => void;
  const postMayFinish = new Promise<void>((resolve) => { releasePost = resolve; });
  let postStarted!: () => void;
  const postDidStart = new Promise<void>((resolve) => { postStarted = resolve; });
  let batches = 0;
  const provider: PrProvider = {
    ...fakeProvider().provider,
    postBatchComments: async (_ref, _sha, comments) => {
      batches++;
      postStarted();
      await postMayFinish;
      return { posted: comments.length };
    },
  };
  const outputs: ReviewerOutput[] = [{
    reviewerName: 'p/one', model: 'm', rawOutput: '', durationMs: 0, exitCode: 0,
    findings: [{ severity: 'HIGH', title: 'x', body: 'one concurrent finding', file: 'src/a.ts', line: 11 }],
  }];
  const args = {
    prUrl: 'u', outDir: dir, gather: gatherFixture(), outputs,
    dedupeMode: 'strict' as const, publish: true, dryRun: false,
    findingsUnavailable: false, overallStart: Date.now(), provider, homeOverride: home,
  };
  try {
    const first = finalizeReview(args);
    await postDidStart;
    await assert.rejects(
      finalizeReview(args),
      /finalization is already in progress.*refusing concurrent posting/,
    );
    assert.equal(batches, 1, 'the contending finalizer never reaches the provider');
    releasePost();
    const completed = await first;
    assert.equal(completed.exitCode, 0);
    assert.equal(batches, 1);
    assert.ok(existsSync(join(dir, 'posted.marker')));
  } finally {
    releasePost?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('finalizeReview — operational coverage failure keeps the summary but exits 2', async () => {
  const id = 'finalize-operational-failure-test';
  const dir = seedRun(id);
  try {
    const outputs: ReviewerOutput[] = [
      { reviewerName: 'p/one', model: 'm', findings: [], rawOutput: '', durationMs: 0, exitCode: 0 },
    ];
    const result = await finalizeReview({
      prUrl: 'u',
      outDir: dir,
      gather: gatherFixture(),
      outputs,
      dedupeMode: 'strict',
      publish: false,
      dryRun: true,
      findingsUnavailable: false,
      operationalFailures: ["planned companion 'companion:x' produced no output"],
      overallStart: Date.now(),
    });
    assert.equal(result.exitCode, 2);
    assert.ok(existsSync(join(dir, 'pr-review-summary.md')), 'parseable findings still get a summary');
    assert.ok(existsSync(join(dir, ERROR_FILE)), 'operational failure marker drives detached status');
    assert.match(result.summary, /planned companion 'companion:x' produced no output/);
    const status = runStatus(basename(dir));
    assert.equal(status.state, 'failed');
    assert.match(status.text, /operational review failure/);
    assert.ok(!readProgress(dir).some((event) => event.phase === 'done'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: 'an unverified post outcome',
    readFails: true,
    summaryPatterns: [/post outcome could not be verified/, /1 finding post\(s\) failed/, /Unverified/],
  },
  {
    name: 'a verified failed post',
    readFails: false,
    summaryPatterns: [/1 finding post\(s\) failed/],
  },
] as const) {
  test(`finalizeReview — ${scenario.name} is an operational failure`, async () => {
    const id = `finalize-post-${scenario.readFails ? 'unverified' : 'failed'}-test`;
    const dir = seedRun(id);
    // Without homeOverride, finalizeReview takes its lease under the real
    // ~/.pr-review/control/ and leaves the directory behind on the developer's
    // machine every test run. (`control.key` itself comes from status.test.ts,
    // which needs the real home because runStatus resolves RUNS_ROOT itself.)
    const home = mkdtempSync(join(tmpdir(), 'finalize-post-home-'));
    try {
      const outputs: ReviewerOutput[] = [{
        reviewerName: 'p/one', model: 'm', rawOutput: '', durationMs: 0, exitCode: 0,
        findings: [{ severity: 'HIGH', title: 'x', body: 'posting failure finding', file: 'src/a.ts', line: 11 }],
      }];
      const result = await finalizeReview({
        prUrl: 'u', outDir: dir, gather: gatherFixture(), outputs,
        dedupeMode: 'strict', publish: true, dryRun: false,
        findingsUnavailable: false, overallStart: Date.now(),
        provider: failingPostProvider(scenario.readFails),
        homeOverride: home,
      });

      assert.equal(result.exitCode, 2);
      assert.ok(existsSync(join(dir, 'pr-review-summary.md')), 'findings still get a degraded summary');
      assert.ok(existsSync(join(dir, ERROR_FILE)), 'posting failure marks the run failed');
      for (const pattern of scenario.summaryPatterns) assert.match(result.summary, pattern);
      const phases = readProgress(dir).map((event) => event.phase);
      assert.ok(phases.includes('error'));
      assert.ok(!phases.includes('done'));
      assert.equal(runStatus(basename(dir)).state, 'failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test('finalizeReview — a later successful finalize clears stale operational failure state', async () => {
  const id = 'finalize-operational-recovery-test';
  const dir = seedRun(id);
  try {
    const outputs: ReviewerOutput[] = [
      { reviewerName: 'p/one', model: 'm', findings: [], rawOutput: '', durationMs: 0, exitCode: 0 },
    ];
    const base = {
      prUrl: 'u', outDir: dir, gather: gatherFixture(), outputs,
      dedupeMode: 'strict' as const, publish: false, dryRun: true,
      findingsUnavailable: false, overallStart: Date.now(),
    };
    const failed = await finalizeReview({ ...base, operationalFailures: ['companion output missing'] });
    assert.equal(failed.exitCode, 2);
    assert.ok(existsSync(join(dir, ERROR_FILE)));

    const recovered = await finalizeReview(base);
    assert.equal(recovered.exitCode, 0);
    assert.ok(!existsSync(join(dir, ERROR_FILE)));
    assert.equal(runStatus(basename(dir)).state, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizeReview — existing-comment refresh uses the hydrated gather PR project', async () => {
  const id = 'finalize-hydrated-refresh-test';
  const dir = seedRun(id);
  try {
    const gather = gatherFixture();
    gather.pr = {
      provider: 'azuredevops', url: 'https://dev.azure.com/org/_git/r/pullrequest/1',
      owner: 'org', organization: 'org', project: 'Platform', repo: 'r', number: 1,
    };
    let refreshedProject: string | undefined;
    const provider: PrProvider = {
      name: 'azuredevops', authEnv: () => ({}),
      parseUrl: (url): PrRef => ({
        provider: 'azuredevops', url, owner: 'org', organization: 'org', repo: 'r', number: 1,
      }),
      fetchMetadata: async () => gather.metadata,
      fetchChangedFiles: async () => [],
      fetchExistingComments: async (ref) => {
        refreshedProject = ref.project;
        return [];
      },
      postLineComment: async () => null,
      isTransientError: () => false,
    };
    const result = await finalizeReview({
      prUrl: gather.pr.url, outDir: dir, gather,
      outputs: [{ reviewerName: 'p/one', model: 'm', findings: [], rawOutput: '', durationMs: 0, exitCode: 0 }],
      dedupeMode: 'strict', publish: false, dryRun: true, refreshExisting: true,
      findingsUnavailable: false, overallStart: Date.now(), provider,
    });
    assert.equal(refreshedProject, 'Platform');
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
