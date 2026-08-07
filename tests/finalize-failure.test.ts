import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT } from '../src/util/tmp.js';
import { finalizeReview } from '../src/commands/review.js';
import { ERROR_FILE, runStatus } from '../src/commands/status.js';
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
    fullDiff: '', existingComments: [], gatheredAt: '',
  };
}

function fakeProvider() {
  const calls = { batches: [] as BatchComment[][] };
  const provider: PrProvider = {
    name: 'github',
    parseUrl: (url: string): PrRef => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchFullDiff: async () => '',
    fetchExistingComments: async () => [],
    postLineComment: async () => ({ id: 'x' }),
    postBatchComments: async (_ref, _sha, comments) => {
      calls.batches.push(comments);
      return { posted: comments.length };
    },
  };
  return { provider, calls };
}

// Seed under RUNS_ROOT with a dead pid so runStatus can be asserted directly.
const DEAD_PID = 2147483646;
function seedRun(id: string): string {
  const dir = join(RUNS_ROOT, id);
  mkdirSync(dir, { recursive: true });
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

    const s = runStatus(id);
    assert.equal(s.state, 'failed', 'status must not read the failure as a clean review');
    assert.match(s.text, /NOT a clean PR/, 'the recorded error is surfaced inline');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalizeReview — codex sibling findings still post on a pipeline failure, exit stays 2', async () => {
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
    assert.equal(calls.batches.length, 1, 'the lone sibling pass is still posted');
    assert.equal(r.exitCode, 2, 'a sibling pass is not a complete review — still a pipeline failure');
    assert.ok(!existsSync(join(dir, 'pr-review-summary.md')), 'still no done-state artifact');
    assert.ok(existsSync(join(dir, ERROR_FILE)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
