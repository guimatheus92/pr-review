import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview } from '../src/commands/review.js';
import { writePostedMarker } from '../src/util/posted-marker.js';
import { controlDirForRun, RUNS_ROOT } from '../src/util/tmp.js';
import { prepareSessionContext, resumePlannedSession } from '../src/dispatch/single-session.js';
import {
  attemptOutputPath,
  createDeliveryState,
  inspectReviewerDelivery,
  writeDeliveryState,
} from '../src/dispatch/delivery.js';
import type { Finding, PrRef } from '../src/types.js';
import type { BatchComment, PrProvider } from '../src/providers/types.js';
import { runStatus } from '../src/commands/status.js';

const PATCH = ['@@ -10,4 +10,5 @@', ' c10', '-old11', '+new11', '+new12', ' c13'].join('\n');
const INDEX_ENTRY = {
  name: 'pack/on-demand',
  description: 'advisory rules',
  source: '/on-demand.md',
  body: 'review on-demand concerns',
  tags: ['typescript'],
};

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

const TEST_HOME = mkdtempSync(join(tmpdir(), 'pr-resume-home-'));

function fakeProvider() {
  const calls = { batches: [] as BatchComment[][], singles: [] as Finding[] };
  const provider: PrProvider = {
    name: 'github',
    parseUrl: (url: string): PrRef => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchFullDiff: async () => '',
    fetchExistingComments: async () => [],
    isTransientError: () => false,
    postLineComment: async (_ref, f) => {
      if (!f.file || !f.line) return null;
      calls.singles.push(f);
      return { id: 'x' };
    },
    postBatchComments: async (_ref, _sha, comments) => {
      calls.batches.push(comments);
      return { posted: comments.length };
    },
  };
  return { provider, calls };
}

/** Seed a run dir with the two on-disk artifacts resume needs. */
function seedRun(reviewers: Array<{ name: string; findings: Finding[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-'));
  writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
  writeFileSync(join(dir, 'single-session-findings.json'), JSON.stringify({ reviewers }), 'utf8');
  return dir;
}

function seedPlannedPartialRun(underRunsRoot = false) {
  if (underRunsRoot) mkdirSync(RUNS_ROOT, { recursive: true });
  const dir = mkdtempSync(join(underRunsRoot ? RUNS_ROOT : tmpdir(), 'pr-resume-planned-'));
  const gather = gatherFixture();
  writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gather), 'utf8');
  const controlDir = controlDirForRun(dir, TEST_HOME);
  const ctx = prepareSessionContext({
    prUrl: gather.pr.url,
    gather,
    passes: [
      { name: 'pack/valid', source: '/valid.md', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true },
      { name: 'pack/missing', source: '/missing.md', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true },
    ],
    indexEntries: [INDEX_ENTRY],
    stackTags: ['typescript'],
    installedCompanions: [],
    skipReviewers: [],
    outDir: dir,
    controlDir,
    invokeCompanions: false,
    runtime: 'copilot',
    execution: { dryRun: true, publish: false, dedupeMode: 'strict' },
  });
  const plan = ctx.dispatchPlan!;
  writeFileSync(plan.reviewers[0]!.canonicalOutputPath, '[]', 'utf8');
  const inventory = inspectReviewerDelivery(
    Object.fromEntries(plan.reviewers.map((reviewer) => [reviewer.name, reviewer.canonicalOutputPath])),
    plan.model,
    0,
  );
  const state = createDeliveryState(plan, inventory);
  state.reviewerAttempts['pack/valid'] = 1;
  state.reviewerAttempts['pack/missing'] = 2;
  writeDeliveryState(state, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!);
  return {
    dir,
    gather,
    plan,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(controlDir, { recursive: true, force: true });
    },
  };
}

function enableCodexOnSeed(seeded: ReturnType<typeof seedPlannedPartialRun>) {
  const ctx = prepareSessionContext({
    prUrl: seeded.gather.pr.url,
    gather: seeded.gather,
    passes: [
      { name: 'pack/valid', source: '/valid.md', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true },
      { name: 'pack/missing', source: '/missing.md', body: 'review', matchedBy: 'baseline', matchedOn: [], baseline: true },
    ],
    indexEntries: [INDEX_ENTRY], stackTags: ['typescript'], installedCompanions: [], skipReviewers: [],
    outDir: seeded.dir, controlDir: controlDirForRun(seeded.dir, TEST_HOME), invokeCompanions: false,
    includeCodex: true, runtime: 'copilot', execution: { dryRun: true, publish: false, dedupeMode: 'strict' },
  });
  const plan = ctx.dispatchPlan!;
  writeFileSync(plan.reviewers[0]!.canonicalOutputPath, '[]', 'utf8');
  const inventory = inspectReviewerDelivery(
    Object.fromEntries(plan.reviewers.map((reviewer) => [reviewer.name, reviewer.canonicalOutputPath])),
    plan.model,
    0,
  );
  const state = createDeliveryState(plan, inventory);
  state.reviewerAttempts['pack/valid'] = 1;
  state.reviewerAttempts['pack/missing'] = 2;
  state.codex = { state: 'pending', attempts: 1 };
  writeDeliveryState(state, ctx.deliveryStatePath!, ctx.authoritativeDeliveryStatePath!);
  return { plan, state };
}

const SEVERE_NO_VERIFIER: Array<{ name: string; findings: Finding[] }> = [
  { name: 'security', findings: [{ severity: 'HIGH', title: 'x', body: 'a real finding body', file: 'src/a.ts', line: 11 }] },
];
const ONE: Array<{ name: string; findings: Finding[] }> = [
  ...SEVERE_NO_VERIFIER,
  { name: 'verifier', findings: [] },
];

test('resume — reuses on-disk reviewer outputs, posts them, and writes posted.marker (no session spawn)', async () => {
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    const r = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.equal(calls.batches.length, 1, 'posted via one batch');
    assert.equal(calls.batches[0].length, 1);
    assert.ok(existsSync(join(dir, 'posted.marker')), 'marker written after a successful post');
    assert.match(r.summary, /PR Review Summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — severe legacy consolidated output without verifier evidence cannot publish', async () => {
  const dir = seedRun(SEVERE_NO_VERIFIER);
  try {
    const { provider, calls } = fakeProvider();
    await assert.rejects(
      runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider }),
      /severe legacy consolidated findings have no verifier evidence/,
    );
    assert.equal(calls.batches.length + calls.singles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — rejects a URL for a different saved PR before any read or write', async () => {
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    provider.parseUrl = (url: string): PrRef => ({ provider: 'github', url, owner: 'o', repo: 'other', number: 2 });
    await assert.rejects(
      runReview({ homeOverride: TEST_HOME, prUrl: 'other', resumeRunId: 'x', runDir: dir, publish: true, provider }),
      /does not match the PR identity saved/,
    );
    assert.equal(calls.batches.length + calls.singles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — re-reads the PR, so findings the interrupted run already posted are not posted again', async () => {
  // The killer detail from the field incident: gather.existingComments is a
  // snapshot taken BEFORE the first post attempt, so the comments that run
  // managed to publish are invisible to dedupe. Without the refresh this
  // resume posts a second copy of every finding.
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    provider.fetchExistingComments = async () => [
      {
        id: '1',
        author: 'me',
        body: 'a real finding body',
        file: 'src/a.ts',
        line: 11,
        createdAt: new Date().toISOString(),
        source: 'human' as const,
      },
    ];
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.equal(calls.batches.length, 0, 'nothing to post — the PR already has it');
    assert.equal(calls.singles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — dedupe off still reconciles an exact comment from the interrupted run', async () => {
  const reviewers = [{
    name: 'security',
    findings: [{
      severity: 'HIGH' as const, title: 'x', body: 'a real finding body', file: 'src/a.ts', line: 3787,
    }],
  }, { name: 'verifier', findings: [] as Finding[] }];
  const dir = seedRun(reviewers);
  try {
    const { provider, calls } = fakeProvider();
    provider.fetchExistingComments = async () => [{ ...PUBLISHED, line: 13 }];
    await runReview({
      homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir,
      publish: true, dedupeMode: 'off', provider,
    });
    assert.equal(calls.batches.length, 0, 'the exact post-snap comment is never duplicated');
    assert.equal(calls.singles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — dedupe off does not adopt the same body at a different location', async () => {
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    provider.fetchExistingComments = async () => [{ ...PUBLISHED, line: 13 }];
    await runReview({
      homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir,
      publish: true, dedupeMode: 'off', provider,
    });
    assert.equal(calls.batches.length, 1, 'same text at another line is a distinct finding');
    assert.equal(calls.batches[0]!.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The comment an interrupted run of this tool already published. */
const PUBLISHED = {
  id: '1',
  author: 'me',
  body: 'a real finding body',
  file: 'src/a.ts',
  line: 11,
  createdAt: new Date().toISOString(),
  source: 'human' as const,
};

test('resume — a DRY-RUN also dedupes against the live PR, not the gather snapshot', async () => {
  // The dry-run is what a user reads before deciding to resume for real, so
  // "1 finding to post" when the publish run would post none is the same
  // miscount, one step earlier.
  const dir = seedRun(ONE);
  try {
    const { provider } = fakeProvider();
    provider.fetchExistingComments = async () => [PUBLISHED];
    const r = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: false, dryRun: true, provider });
    assert.ok(!r.summary.includes('a real finding body'), 'the already-published finding is not offered again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — the refresh only adopts comments matching a finding this run would post', async () => {
  // Assigning the whole live list would let any comment on the changed lines
  // suppress a finding: strict dedupe drops on 0.4 title similarity, so a few
  // vague inline comments would silently bury the matching security findings.
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    provider.fetchExistingComments = async () => [
      { ...PUBLISHED, id: 'human-1', body: 'possible injection risk here, double-check this', author: 'someone-else' },
    ];
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.equal(calls.batches.length, 1, 'a bystander comment must not suppress the finding');
    assert.equal(calls.batches[0].length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a publishing resume that cannot re-read the PR fails closed; --force-post overrides', async () => {
  // Continuing would dedupe against a snapshot known to predate a post attempt
  // and re-post everything the interrupted run published — and nothing
  // downstream catches it: runPost reconciles only on an error path, and its
  // window excludes comments written minutes ago.
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    provider.fetchExistingComments = async () => {
      throw new Error('read failed: 500');
    };
    await assert.rejects(
      () => runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider }),
      /refusing to post/,
    );
    assert.equal(calls.batches.length, 0, 'nothing was written');

    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, forcePost: true, provider });
    assert.equal(calls.batches.length, 1, '--force-post is the documented escape hatch');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a DRY-RUN whose refresh fails degrades to the snapshot instead of aborting', async () => {
  const dir = seedRun(ONE);
  try {
    const { provider } = fakeProvider();
    provider.fetchExistingComments = async () => {
      throw new Error('read failed: 500');
    };
    const r = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: false, dryRun: true, provider });
    assert.match(r.summary, /PR Review Summary/, 'a dry-run has nothing to duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — an UNVERIFIED prior post fails closed, even though it is partial', async () => {
  // The half of the root cause the first pass missed: gating the marker write
  // on `posted > 0` left a run with wrong counts no guard at all. Recording the
  // attempt is what makes "stop rather than re-issue" safe.
  const dir = seedRun(ONE);
  try {
    writePostedMarker(dir, { posted: 0, attempted: 1, verified: false });
    const { provider, calls } = fakeProvider();
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.equal(calls.batches.length, 0, 'unverified is not a licence to re-post');

    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, forcePost: true, provider });
    assert.equal(calls.batches.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a publish attempt that posted nothing still records a marker', async () => {
  const dir = seedRun(ONE);
  try {
    const { provider } = fakeProvider();
    // No batch poster and an unplaceable finding → nothing posts, but the
    // attempt happened and must be on record.
    provider.postLineComment = async () => null;
    delete (provider as { postBatchComments?: unknown }).postBatchComments;
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.ok(existsSync(join(dir, 'posted.marker')), 'a 0-posted attempt used to leave no guard at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a second resume refuses to re-post while the marker exists; --force-post overrides', async () => {
  const dir = seedRun(ONE);
  try {
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: fakeProvider().provider });

    const second = fakeProvider();
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: second.provider });
    assert.equal(second.calls.batches.length, 0, 'posted.marker present → no duplicate post');

    const third = fakeProvider();
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, forcePost: true, provider: third.provider });
    assert.equal(third.calls.batches.length, 1, '--force-post overrides the marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — legacy phase1-findings.json is dry-run diagnostic evidence and never publishable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-'));
  try {
    writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
    writeFileSync(join(dir, 'phase1-findings.json'), JSON.stringify({ reviewers: ONE }), 'utf8');
    const { provider, calls } = fakeProvider();
    await assert.rejects(
      runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider }),
      /diagnostic evidence.*refusing to publish/,
    );
    assert.equal(calls.batches.length, 0);
    const preview = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: false, dryRun: true, provider });
    assert.match(preview.summary, /PR Review Summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a corrupt posted.marker fails closed (no re-post) unless --force-post', async () => {
  const dir = seedRun(ONE);
  try {
    writeFileSync(join(dir, 'posted.marker'), '{ corrupt not json', 'utf8');
    const a = fakeProvider();
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: a.provider });
    assert.equal(a.calls.batches.length, 0, 'corrupt marker → refuse (fail closed)');
    const b = fakeProvider();
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, forcePost: true, provider: b.provider });
    assert.equal(b.calls.batches.length, 1, '--force-post overrides');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a partial prior post (posted < attempted) is retried, not skipped', async () => {
  const dir = seedRun(ONE);
  try {
    writePostedMarker(dir, { posted: 1, attempted: 3 }); // a partial post left findings unposted
    const a = fakeProvider();
    await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: a.provider });
    assert.equal(a.calls.batches.length, 1, 'partial marker must not strand the un-posted findings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — Skills section: omitted when passes.json is absent, rendered when present', async () => {
  const noRouting = seedRun(ONE);
  try {
    const r = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: noRouting, publish: false, dryRun: true, provider: fakeProvider().provider });
    assert.ok(!r.summary.includes('## Skills'), 'no routing artifact → Skills section omitted (degrades)');
  } finally {
    rmSync(noRouting, { recursive: true, force: true });
  }

  const withRouting = seedRun(ONE);
  try {
    writeFileSync(
      join(withRouting, 'passes.json'),
      JSON.stringify([{ name: 'owasp/nodejs-security', source: 's', matchedBy: 'tag' }]),
      'utf8',
    );
    const r = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: withRouting, publish: false, dryRun: true, provider: fakeProvider().provider });
    assert.ok(r.summary.includes('## Skills'), 'routing artifact present → Skills section rendered');
    assert.ok(r.summary.includes('| owasp/nodejs-security | tag |'), 'pass row present on resume');
  } finally {
    rmSync(withRouting, { recursive: true, force: true });
  }
});

test('resume — a corrupt or wrong-shape passes.json degrades, never aborts the resume', async () => {
  // Wrong shape parses fine but would crash summarizePasses — AFTER posting — if unvalidated.
  for (const bad of ['{"name":', '{}', 'null', '[{"name":"x"}]', '[{"matchedBy":"glob"}]']) {
    const dir = seedRun(ONE);
    try {
      writeFileSync(join(dir, 'passes.json'), bad, 'utf8');
      const r = await runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: false, dryRun: true, provider: fakeProvider().provider });
      assert.match(r.summary, /PR Review Summary/, `resume completed for ${bad}`);
      assert.ok(!r.summary.includes('## Skills'), `Skills section omitted for ${bad}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('resume — missing gather and missing reviewer output each error clearly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-'));
  try {
    await assert.rejects(
      runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: fakeProvider().provider }),
      /no pr-review-gather/,
    );
    writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
    await assert.rejects(
      runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: fakeProvider().provider }),
      /nothing to resume/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — legacy partial raw sidecars are explicit evidence, never selectively recovered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-legacy-partial-'));
  try {
    writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
    writeFileSync(join(dir, 'raw-quality.json'), '[]', 'utf8');
    await assert.rejects(
      runReview({ homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: dir, dryRun: true, provider: fakeProvider().provider }),
      /legacy partial run.*selective recovery is unsupported/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — schema-v1 partial run dispatches only unresolved reviewer at attempt 3 and remains dry-run', async () => {
  const seeded = seedPlannedPartialRun();
  try {
    const { provider, calls } = fakeProvider();
    const prompts: string[] = [];
    const result = await runReview({
      homeOverride: TEST_HOME,
      prUrl: 'u',
      resumeRunId: 'x',
      runDir: seeded.dir,
      publish: false,
      dryRun: true,
      provider,
      resumePlannedSessionFn: (plan, statePath, authoritativeStatePath) =>
        resumePlannedSession(plan, statePath, authoritativeStatePath, async (args) => {
          prompts.push(args.promptBody);
          assert.ok(args.promptBody.includes('record as reviewer name `pack/missing`'));
          assert.ok(!args.promptBody.includes('record as reviewer name `pack/valid`'));
          writeFileSync(attemptOutputPath(plan.reviewers[1]!, 3), '[]', 'utf8');
          return { stdout: 'DONE', stderr: '', exitCode: 0, timedOut: false };
        }),
    });
    assert.equal(prompts.length, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(calls.batches.length + calls.singles.length, 0, 'sticky dry-run never posts');
    assert.ok(existsSync(seeded.plan.findingsPath));
    assert.ok(!existsSync(join(seeded.dir, 'posted.marker')));
  } finally {
    seeded.cleanup();
  }
});

test('resume — concurrent schema-v1 recovery admits one owner and status reports it running', async () => {
  const seeded = seedPlannedPartialRun(true);
  let releaseRecovery!: () => void;
  const recoveryMayFinish = new Promise<void>((resolve) => { releaseRecovery = resolve; });
  let recoveryStarted!: () => void;
  const recoveryDidStart = new Promise<void>((resolve) => { recoveryStarted = resolve; });
  let firstCalls = 0;
  let contenderCalls = 0;
  try {
    const first = runReview({
      homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: seeded.dir,
      publish: false, dryRun: true, provider: fakeProvider().provider,
      resumePlannedSessionFn: async (plan, statePath, authorityPath) => {
        firstCalls++;
        recoveryStarted();
        await recoveryMayFinish;
        return resumePlannedSession(plan, statePath, authorityPath, async () => {
          writeFileSync(attemptOutputPath(plan.reviewers[1]!, 3), '[]');
          return { stdout: 'DONE', stderr: '', exitCode: 0 };
        });
      },
    });
    await recoveryDidStart;
    assert.equal(runStatus(seeded.dir.split(/[\\/]/).pop()!).state, 'running');
    assert.equal(readFileSync(join(seeded.dir, 'run.pid'), 'utf8').trim(), String(process.pid));
    await assert.rejects(
      runReview({
        homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: seeded.dir,
        publish: false, dryRun: true, provider: fakeProvider().provider,
        resumePlannedSessionFn: async () => {
          contenderCalls++;
          throw new Error('contender must not reach recovery');
        },
      }),
      /finalization is already in progress.*refusing concurrent posting/,
    );
    assert.equal(contenderCalls, 0);
    assert.equal(firstCalls, 1);
    releaseRecovery();
    assert.equal((await first).exitCode, 0);
    assert.equal(existsSync(join(seeded.dir, 'run.pid')), false);
  } finally {
    releaseRecovery?.();
    seeded.cleanup();
  }
});

test('resume — completed Codex attempt survives parent crash without rerunning Codex', async () => {
  const seeded = seedPlannedPartialRun();
  try {
    const { plan } = enableCodexOnSeed(seeded);
    writeFileSync(join(plan.codex.attemptsDir, 'attempt-1.json'), JSON.stringify([
      { severity: 'LOW', title: 'codex', body: 'second opinion', file: 'src/a.ts', line: 11 },
    ]));
    let codexCalls = 0;
    const result = await runReview({
      homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: seeded.dir,
      publish: false, dryRun: true, provider: fakeProvider().provider,
      resumePlannedSessionFn: (savedPlan, statePath, authorityPath) =>
        resumePlannedSession(savedPlan, statePath, authorityPath, async () => {
          writeFileSync(attemptOutputPath(savedPlan.reviewers[1]!, 3), '[]');
          return { stdout: 'DONE', stderr: '', exitCode: 0 };
        }),
      runCodexReviewerFn: async () => {
        codexCalls++;
        throw new Error('Codex must not rerun');
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(codexCalls, 0);
    assert.ok(result.outputs.some((output) => output.reviewerName === 'codex'));
  } finally {
    seeded.cleanup();
  }
});

test('resume — authenticated failed Codex attempt is retried, never upgraded from its old output', async () => {
  const seeded = seedPlannedPartialRun();
  try {
    const { plan, state } = enableCodexOnSeed(seeded);
    const partial = [{ severity: 'LOW', title: 'partial', body: 'incomplete', file: 'src/a.ts', line: 11 }];
    writeFileSync(join(plan.codex.attemptsDir, 'attempt-1.json'), JSON.stringify(partial));
    state.codex = {
      state: 'failed', attempts: 1,
      output: { reviewerName: 'codex', model: 'codex', findings: partial as Finding[], rawOutput: JSON.stringify(partial), durationMs: 1, exitCode: 137, error: 'exited 137' },
    };
    writeDeliveryState(state, join(seeded.dir, 'delivery-state.json'), join(controlDirForRun(seeded.dir, TEST_HOME), 'delivery-state.json'));
    let codexCalls = 0;
    const result = await runReview({
      homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: seeded.dir,
      publish: false, dryRun: true, provider: fakeProvider().provider,
      resumePlannedSessionFn: (savedPlan, statePath, authorityPath) =>
        resumePlannedSession(savedPlan, statePath, authorityPath, async () => {
          writeFileSync(attemptOutputPath(savedPlan.reviewers[1]!, 3), '[]');
          return { stdout: 'DONE', stderr: '', exitCode: 0 };
        }),
      runCodexReviewerFn: async (options) => {
        codexCalls++;
        assert.ok(options.outputPath?.endsWith('attempt-2.json'));
        return { reviewerName: 'codex', model: 'codex', findings: [], rawOutput: '[]', durationMs: 1, exitCode: 0 };
      },
    });
    assert.equal(codexCalls, 1);
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs.find((output) => output.reviewerName === 'codex')?.findings.length, 0);
  } finally {
    seeded.cleanup();
  }
});

test('resume — pending final Codex attempt is adopted before terminal exhaustion gate', async () => {
  const seeded = seedPlannedPartialRun();
  try {
    const { plan, state } = enableCodexOnSeed(seeded);
    const final = [{ severity: 'LOW', title: 'final', body: 'complete', file: 'src/a.ts', line: 11 }];
    state.codex = { state: 'pending', attempts: plan.codex.maxAttempts };
    state.kind = 'terminal-incomplete';
    state.reasonCodes = ['codex-delivery-incomplete'];
    writeDeliveryState(state, join(seeded.dir, 'delivery-state.json'), join(controlDirForRun(seeded.dir, TEST_HOME), 'delivery-state.json'));
    writeFileSync(join(plan.codex.attemptsDir, `attempt-${plan.codex.maxAttempts}.json`), JSON.stringify(final));
    let codexCalls = 0;
    const result = await runReview({
      homeOverride: TEST_HOME, prUrl: 'u', resumeRunId: 'x', runDir: seeded.dir,
      publish: false, dryRun: true, provider: fakeProvider().provider,
      resumePlannedSessionFn: (savedPlan, statePath, authorityPath) =>
        resumePlannedSession(savedPlan, statePath, authorityPath, async () => {
          writeFileSync(attemptOutputPath(savedPlan.reviewers[1]!, 3), '[]');
          return { stdout: 'DONE', stderr: '', exitCode: 0 };
        }),
      runCodexReviewerFn: async () => {
        codexCalls++;
        throw new Error('pending final attempt must be adopted');
      },
    });
    assert.equal(codexCalls, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.outputs.find((output) => output.reviewerName === 'codex')?.findings[0]?.title, 'final');
  } finally {
    seeded.cleanup();
  }
});

for (const scenario of [
  {
    name: 'execution mode changes',
    expected: /mode-mismatch/,
    mutate: (_seeded: ReturnType<typeof seedPlannedPartialRun>, _provider: PrProvider) => ({ dryRun: false, publish: true }),
  },
  {
    name: 'the PR head changes',
    expected: /stale-pr/,
    mutate: (_seeded: ReturnType<typeof seedPlannedPartialRun>, provider: PrProvider) => {
      provider.fetchMetadata = async () => ({ ...gatherFixture().metadata, headSha: 'force-pushed' });
      return { dryRun: true, publish: false };
    },
  },
  {
    name: 'an immutable pass file changes',
    expected: /artifact-drift/,
    mutate: (seeded: ReturnType<typeof seedPlannedPartialRun>, _provider: PrProvider) => {
      writeFileSync(seeded.plan.artifacts.find((artifact) => artifact.path.includes('pass-pack_valid--'))!.path, 'changed', 'utf8');
      return { dryRun: true, publish: false };
    },
  },
  {
    name: 'a materialized on-demand skill changes',
    expected: /artifact-drift/,
    mutate: (seeded: ReturnType<typeof seedPlannedPartialRun>, _provider: PrProvider) => {
      const indexedSkill = seeded.plan.artifacts.find((artifact) => artifact.path.includes('indexed-skill-'));
      assert.ok(indexedSkill, 'seeded plan includes a materialized on-demand skill');
      writeFileSync(indexedSkill.path, 'changed', 'utf8');
      return { dryRun: true, publish: false };
    },
  },
  {
    name: 'a posting marker exists',
    expected: /posted-marker-present/,
    mutate: (seeded: ReturnType<typeof seedPlannedPartialRun>, _provider: PrProvider) => {
      writePostedMarker(seeded.dir, { posted: 0, attempted: 0, verified: true }, TEST_HOME);
      return { dryRun: true, publish: false };
    },
  },
] as const) {
  test(`resume — schema-v1 recovery refuses before spawn when ${scenario.name}`, async () => {
    const seeded = seedPlannedPartialRun();
    try {
      const { provider, calls } = fakeProvider();
      const mode = scenario.mutate(seeded, provider);
      let spawns = 0;
      await assert.rejects(
        runReview({
          homeOverride: TEST_HOME,
          prUrl: 'u',
          resumeRunId: 'x',
          runDir: seeded.dir,
          provider,
          ...mode,
          resumePlannedSessionFn: async () => {
            spawns++;
            throw new Error('must not spawn');
          },
        }),
        scenario.expected,
      );
      assert.equal(spawns, 0);
      assert.equal(calls.batches.length + calls.singles.length, 0);
    } finally {
      seeded.cleanup();
    }
  });
}
