import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlDirForRun, ERROR_FILE } from '../src/util/tmp.js';
import {
  createDispatchPlan,
  readAuthoritativeDispatchPlan,
  writeDeliveryState,
  writeDispatchPlan,
  writeFinalizationRecord,
  type DeliveryState,
} from '../src/dispatch/delivery.js';
import { writePostedMarker } from '../src/util/posted-marker.js';
import { sha256File } from '../src/util/atomic-json.js';
import { CHECKS, TEST_ONLY, loadVerifyContext, runChecks, runVerify } from '../src/commands/verify.js';
import type { PrProvider } from '../src/providers/types.js';
import type { ExistingComment, Finding, PrMetadata } from '../src/types.js';

const RUN_ID = 'github__o__r__1__1970-01-01T00-00-00-000Z';
const PR_URL = 'https://github.com/o/r/pull/1';
const BOT = 'pr-review-bot';
const PATCH = '@@ -1,3 +1,4 @@\n a\n+added\n b\n c';

interface Fixture {
  home: string;
  runDir: string;
  comments: ExistingComment[];
  metadata: PrMetadata;
  cleanup(): void;
}

function comment(over: Partial<ExistingComment> & { body: string }): ExistingComment {
  return {
    id: over.id ?? `c-${Math.random().toString(36).slice(2)}`,
    author: over.author ?? BOT,
    body: over.body,
    file: over.file,
    line: over.line,
    createdAt: over.createdAt ?? '2024-01-01T00:00:10.000Z',
    source: over.source ?? 'bot',
  };
}

function stubProvider(f: Fixture): PrProvider {
  return {
    name: 'github',
    authEnv: () => ({}),
    parseUrl: () => null,
    fetchMetadata: async () => f.metadata,
    fetchChangedFiles: async () => [],
    fetchExistingComments: async () => f.comments,
    postLineComment: async () => null,
    isTransientError: () => false,
  } as unknown as PrProvider;
}

/**
 * A run that honours every invariant. Each test mutates exactly one thing and
 * asserts exactly one row flips — otherwise a check could be passing for the
 * wrong reason and no test would notice.
 */
function healthyRun(over: {
  findings?: Finding[];
  dryRun?: boolean;
  changedFilesComplete?: boolean;
  exitCode?: 0 | 1 | 2;
  errorTxt?: boolean;
  companionsMissing?: string[];
  deliveryKind?: DeliveryState['kind'];
  headSha?: string;
  repoRoot?: string;
  /** Applied before the plan is signed, so the mutation is authentic, not tampering. */
  mutatePlan?: (plan: Record<string, unknown>) => void;
  /** Applied before the state is signed. Keeps planFingerprint intact. */
  mutateState?: (state: DeliveryState) => void;
} = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-verify-'));
  const runDir = join(home, '.pr-review', 'runs', RUN_ID);
  mkdirSync(runDir, { recursive: true });

  const findings: Finding[] = over.findings ?? [
    { severity: 'HIGH', title: 'one', body: 'first finding body', file: 'src/a.ts', line: 2 },
    { severity: 'LOW', title: 'two', body: 'second finding body', file: 'src/a.ts', line: 3 },
  ];
  const dryRun = over.dryRun ?? false;

  const gather = {
    pr: { provider: 'github', url: PR_URL, owner: 'o', repo: 'r', number: 1 },
    metadata: {
      title: 'a PR',
      author: 'human',
      headSha: 'head1234',
      baseSha: 'base1234',
      headBranch: 'feature',
      baseBranch: 'main',
      state: 'open',
      isDraft: false,
      changedFileCount: 1,
    },
    changedFiles: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, patch: PATCH }],
    existingComments: [],
    gatheredAt: '2024-01-01T00:00:00.000Z',
    ...(over.changedFilesComplete === false ? {} : { changedFilesComplete: true }),
  };
  writeFileSync(join(runDir, 'pr-review-gather.json'), JSON.stringify(gather), 'utf8');
  writeFileSync(join(runDir, 'stack.json'), JSON.stringify({ languages: ['typescript'], dependencies: ['express'], ecosystems: ['node'], tags: [], notes: [], cwdIsPrRepo: true }), 'utf8');
  writeFileSync(
    join(runDir, 'passes.json'),
    JSON.stringify([
      { name: 'pack/security', matchedBy: 'baseline' },
      { name: 'team-rules', matchedBy: 'context', source: '.claude/skills/team-rules.md' },
    ]),
    'utf8',
  );
  writeFileSync(
    join(runDir, 'capabilities.json'),
    JSON.stringify({ runtime: 'copilot', installedPlugins: [], selectedPluginSkills: [], mcpServers: [], warnings: [], usage: [] }),
    'utf8',
  );
  writeFileSync(
    join(runDir, 'companions.json'),
    JSON.stringify({ plannedReviewers: [], missingReviewers: over.companionsMissing ?? [], duplicateReviewers: [] }),
    'utf8',
  );
  writeFileSync(join(runDir, 'pr-review-findings.json'), JSON.stringify({ finalFindings: findings, droppedCount: 0 }), 'utf8');
  writeFileSync(join(runDir, 'pr-review-summary.md'), '# PR Review Summary\n', 'utf8');
  writeFileSync(join(runDir, 'progress.ndjson'), '', 'utf8');
  writeFileSync(join(runDir, 'raw-pack_security.json'), '{"findings":[]}', 'utf8');
  if (over.errorTxt) writeFileSync(join(runDir, ERROR_FILE), 'boom\n', 'utf8');

  const controlDir = controlDirForRun(runDir, home);
  const plan = createDispatchPlan({
    runId: RUN_ID,
    runDir,
    createdAt: '2024-01-01T00:00:05.000Z',
    pr: { provider: 'github', url: PR_URL, owner: 'o', repo: 'r', number: 1 },
    metadata: { headSha: 'head1234', baseSha: 'base1234', headBranch: 'feature', baseBranch: 'main', state: 'open', isDraft: false },
    runtime: 'copilot',
    runtimeBinary: 'copilot',
    ...(over.repoRoot ? { repoRoot: over.repoRoot } : {}),
    disabledMcpServers: [],
    model: 'm',
    timeoutMs: 1,
    phase1Path: join(runDir, 'phase1-findings.json'),
    findingsPath: join(runDir, 'single-session-findings.json'),
    execution: { dryRun, publish: !dryRun, dedupeMode: 'strict' },
    configProjection: {},
    configFingerprint: 'test',
    artifacts: [],
    reviewers: [],
    verifier: { enabled: false, maxAttempts: 3 },
    codex: { enabled: false, contextPath: join(runDir, 'pr-context.md'), attemptsDir: join(runDir, 'codex-attempts'), maxAttempts: 3 },
  });
  over.mutatePlan?.(plan as unknown as Record<string, unknown>);
  writeDispatchPlan(plan, join(runDir, 'dispatch-plan.json'), join(controlDir, 'dispatch-plan.json'));

  const state: DeliveryState = {
    schemaVersion: 1,
    planFingerprint: plan.fingerprint,
    updatedAt: '2024-01-01T00:00:20.000Z',
    kind: over.deliveryKind ?? 'complete',
    planned: ['pack/security'],
    valid: ['pack/security'],
    missing: [],
    invalid: [],
    recoveredFindingCount: findings.length,
    severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 1, NIT: 0 },
    reviewerAttempts: {},
    reviewerDigests: {},
    runtimeAttempts: [
      {
        number: 1,
        kind: 'initial',
        reviewers: ['pack/security'],
        startedAt: '2024-01-01T00:00:05.000Z',
        endedAt: '2024-01-01T00:00:15.000Z',
        exitCode: 0,
        timedOut: false,
        timeoutMs: 1,
      },
    ],
    phase1: 'valid',
    consolidated: 'valid',
    verifier: { state: 'not-required', attempts: 0 },
    codex: { state: 'disabled', attempts: 0 },
    reasonCodes: [],
  } as unknown as DeliveryState;
  over.mutateState?.(state);
  writeDeliveryState(state, join(runDir, 'delivery-state.json'), join(controlDir, 'delivery-state.json'));

  if (!dryRun) {
    writePostedMarker(runDir, { posted: findings.length, attempted: findings.length, verified: true }, home);
  }

  const authoritative = readAuthoritativeDispatchPlan(join(controlDir, 'dispatch-plan.json'));
  const summaryPath = join(runDir, 'pr-review-summary.md');
  const findingsPath = join(runDir, 'pr-review-findings.json');
  writeFinalizationRecord(runDir, home, {
    schemaVersion: 1,
    planFingerprint: authoritative.fingerprint,
    completedAt: '2024-01-01T00:00:30.000Z',
    exitCode: over.exitCode ?? 0,
    summaryPath,
    summaryDigest: sha256File(summaryPath),
    findingsPath,
    findingsDigest: sha256File(findingsPath),
  });

  return {
    home,
    runDir,
    comments: dryRun ? [] : findings.map((f) => comment({ body: f.body, file: f.file, line: f.line })),
    metadata: { ...gather.metadata, headSha: over.headSha ?? 'head1234' } as unknown as PrMetadata,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

async function rowsFor(f: Fixture, opts: { offline?: boolean } = {}) {
  const ctx = await loadVerifyContext({
    runId: RUN_ID,
    home: f.home,
    offline: opts.offline,
    providerOverride: stubProvider(f),
  });
  return runChecks(ctx);
}

function row(rows: { id: string; status: string; evidence: string }[], id: string) {
  const found = rows.find((r) => r.id === id);
  assert.ok(found, `no row for ${id}`);
  return found;
}

test('verify — every registered invariant produces exactly one row, always', async () => {
  const f = healthyRun();
  try {
    const rows = await rowsFor(f);
    const expected = [...CHECKS.map((c) => c.id), ...Object.keys(TEST_ONLY)];
    assert.equal(rows.length, expected.length, 'the report must be the full invariant list, never a subset');
    assert.deepEqual([...new Set(rows.map((r) => r.id))].sort(), expected.sort());
  } finally {
    f.cleanup();
  }
});

test('verify — a healthy publish run has no FAIL', async () => {
  const f = healthyRun();
  try {
    const rows = await rowsFor(f);
    const failures = rows.filter((r) => r.status === 'fail');
    assert.deepEqual(
      failures.map((r) => `${r.id}: ${r.evidence}`),
      [],
      'the fixture honours every invariant, so any FAIL is a check reading the artifacts wrong',
    );
    assert.equal(row(rows, 'INV-POST-01').status, 'pass');
    assert.equal(row(rows, 'INV-POST-02').status, 'pass');
  } finally {
    f.cleanup();
  }
});

test('verify — a top-level comment from the posting identity fails INV-POST-02 and INV-POST-06 stays clean', async () => {
  const f = healthyRun();
  try {
    f.comments.push(comment({ body: '### Code review\n\nOverall this looks fine.', author: BOT }));
    const rows = await rowsFor(f);
    const posted2 = row(rows, 'INV-POST-02');
    assert.equal(posted2.status, 'fail', 'a top-level comment by us is the incident this invariant exists for');
    assert.match(posted2.evidence, /top-level comment/i);
    assert.equal(row(rows, 'INV-POST-01').status, 'pass', 'the inline findings still landed');
    assert.equal(row(rows, 'INV-POST-06').status, 'pass', 'POST-06 is about unplanned INLINE writes');
  } finally {
    f.cleanup();
  }
});

test('verify — a top-level comment by someone else is not ours', async () => {
  const f = healthyRun();
  try {
    f.comments.push(comment({ body: 'looks good to me', author: 'a-human-reviewer' }));
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-POST-02').status, 'pass', 'a bystander must never fail our own invariant');
  } finally {
    f.cleanup();
  }
});

test('verify — an unplanned inline comment from us fails INV-POST-06 (a dispatched agent posted)', async () => {
  const f = healthyRun();
  try {
    f.comments.push(comment({ body: 'nit: rename this', file: 'src/a.ts', line: 4, author: BOT }));
    const rows = await rowsFor(f);
    const six = row(rows, 'INV-POST-06');
    assert.equal(six.status, 'fail');
    assert.match(six.evidence, /match no planned finding/);
  } finally {
    f.cleanup();
  }
});

test('verify — a duplicated comment fails INV-POST-05 (the 56→112 incident, observable)', async () => {
  const f = healthyRun();
  try {
    f.comments.push(comment({ body: 'first finding body', file: 'src/a.ts', line: 2 }));
    const rows = await rowsFor(f);
    const five = row(rows, 'INV-POST-05');
    assert.equal(five.status, 'fail');
    assert.match(five.evidence, /src\/a\.ts:2 x2/);
  } finally {
    f.cleanup();
  }
});

test('verify — a missing finding fails INV-POST-01 with the location named', async () => {
  const f = healthyRun();
  try {
    f.comments = f.comments.filter((c) => c.line !== 3);
    const rows = await rowsFor(f);
    const one = row(rows, 'INV-POST-01');
    assert.equal(one.status, 'fail');
    assert.match(one.evidence, /src\/a\.ts:3/);
  } finally {
    f.cleanup();
  }
});

test('verify — a gather without changedFilesComplete fails INV-FETCH-01', async () => {
  const f = healthyRun({ changedFilesComplete: false });
  try {
    const rows = await rowsFor(f);
    const fetch1 = row(rows, 'INV-FETCH-01');
    assert.equal(fetch1.status, 'fail');
    assert.match(fetch1.evidence, /never proved complete/);
  } finally {
    f.cleanup();
  }
});

test('verify — a pre-0.11 gather is unprovable, not a violation, and cannot be faked by a current run', async () => {
  const f = healthyRun({ changedFilesComplete: false });
  try {
    // Neither the marker nor a provider count: the gate did not exist yet.
    const path = join(f.runDir, 'pr-review-gather.json');
    const gather = JSON.parse(readFileSync(path, 'utf8'));
    delete gather.metadata.changedFileCount;
    writeFileSync(path, JSON.stringify(gather), 'utf8');
    const legacy = row(await rowsFor(f), 'INV-FETCH-01');
    assert.equal(legacy.status, 'skip');
    assert.match(legacy.evidence, /predates the file-list completeness gate/);

    // Once the provider count is recorded the gate existed, so a missing marker
    // is a real violation again — a current run cannot reach the legacy branch.
    gather.metadata.changedFileCount = 1;
    writeFileSync(path, JSON.stringify(gather), 'utf8');
    assert.equal(row(await rowsFor(f), 'INV-FETCH-01').status, 'fail');
  } finally {
    f.cleanup();
  }
});

test('verify — comments from a LATER run on the same PR are outside this run window', async () => {
  const f = healthyRun();
  try {
    // A re-review an hour later. Without a window ceiling these read as
    // "written by this run and never planned" — 33 of 58 on the first live run.
    f.comments.push(
      comment({ body: 'first finding body', file: 'src/a.ts', line: 2, createdAt: '2024-01-01T01:00:00.000Z' }),
      comment({ body: 'a later run said this', file: 'src/a.ts', line: 3, createdAt: '2024-01-01T01:00:01.000Z' }),
    );
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-POST-05').status, 'pass', 'a later run duplicating a location is not this run duplicating it');
    assert.equal(row(rows, 'INV-POST-06').status, 'pass', 'a later run is not a dispatched agent writing to the PR');
    assert.match(row(rows, 'INV-POST-05').evidence, /among 2 comment\(s\)/);
  } finally {
    f.cleanup();
  }
});

test('verify — an advanced PR downgrades the location-keyed posting rows to SKIP, never FAIL', async () => {
  const f = healthyRun({ headSha: 'moved999' });
  try {
    f.comments = f.comments.filter((c) => c.line !== 3); // as an outdated comment would look
    const rows = await rowsFor(f);
    const one = row(rows, 'INV-POST-01');
    assert.equal(one.status, 'skip', 'GitHub answers outdated comments at their original line — that is not a lost finding');
    assert.match(one.evidence, /PR advanced \(head123 → moved99\)/);
    assert.equal(row(rows, 'INV-POST-06').status, 'skip');
    assert.equal(rows.filter((r) => r.status === 'fail').length, 0);
  } finally {
    f.cleanup();
  }
});

test('verify — an advanced head SHA downgrades the count comparison but still asserts the flag', async () => {
  const f = healthyRun({ headSha: 'moved999' });
  try {
    const rows = await rowsFor(f);
    const fetch1 = row(rows, 'INV-FETCH-01');
    assert.equal(fetch1.status, 'pass', 'a PR that moved on is not a violation');
    assert.match(fetch1.evidence, /the PR advanced \(head123 → moved99\)/);
  } finally {
    f.cleanup();
  }
});

test('verify — a missing companion with exit 0 fails INV-DEL-01 (the resume accounting gap)', async () => {
  const f = healthyRun({ companionsMissing: ['companion:code-review'] });
  try {
    const rows = await rowsFor(f);
    const del1 = row(rows, 'INV-DEL-01');
    assert.equal(del1.status, 'fail');
    assert.match(del1.evidence, /did not exit 2/);
  } finally {
    f.cleanup();
  }
});

test('verify — the same shortfall reported loudly is not a violation', async () => {
  const f = healthyRun({ companionsMissing: ['companion:code-review'], exitCode: 2, errorTxt: true });
  try {
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-DEL-01').status, 'pass', 'exiting 2 is the invariant being honoured, not broken');
    assert.equal(row(rows, 'INV-OUT-01').status, 'pass');
  } finally {
    f.cleanup();
  }
});

test('verify — incomplete delivery that still posted fails INV-DEL-03', async () => {
  const f = healthyRun({ deliveryKind: 'terminal-incomplete', exitCode: 2, errorTxt: true });
  try {
    const rows = await rowsFor(f);
    const del3 = row(rows, 'INV-DEL-03');
    assert.equal(del3.status, 'fail');
    assert.match(del3.evidence, /but 2 finding\(s\) were posted/);
  } finally {
    f.cleanup();
  }
});

test('verify — a dry run skips the posting rows instead of passing them vacuously', async () => {
  const f = healthyRun({ dryRun: true });
  try {
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-POST-01').status, 'skip');
    assert.match(row(rows, 'INV-POST-01').evidence, /dry-run/);
    assert.equal(row(rows, 'INV-POST-07').status, 'skip');
    assert.equal(rows.filter((r) => r.status === 'fail').length, 0);
  } finally {
    f.cleanup();
  }
});

test('verify — --offline skips every run+pr row with a stated reason, and never fails one', async () => {
  const f = healthyRun();
  try {
    const rows = await rowsFor(f, { offline: true });
    for (const check of CHECKS.filter((c) => c.needs === 'run+pr')) {
      const r = row(rows, check.id);
      assert.equal(r.status, 'skip', `${check.id} must not be graded without the live read`);
      assert.match(r.evidence, /offline/);
    }
    assert.equal(row(rows, 'INV-CTX-02').status, 'pass', 'run-only rows still run offline');
  } finally {
    f.cleanup();
  }
});

test('verify — a missing stack.json fails INV-CTX-01 and a missing capabilities.json fails INV-CTX-02', async () => {
  const f = healthyRun();
  try {
    rmSync(join(f.runDir, 'stack.json'));
    rmSync(join(f.runDir, 'capabilities.json'));
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-CTX-01').status, 'fail');
    assert.equal(row(rows, 'INV-CTX-02').status, 'fail');
    assert.equal(row(rows, 'INV-OUT-02').status, 'fail', 'the artifact contract notices too');
  } finally {
    f.cleanup();
  }
});

test('verify — stack evidence may be empty only when a note says why', async () => {
  const f = healthyRun();
  try {
    writeFileSync(join(f.runDir, 'stack.json'), JSON.stringify({ languages: [], dependencies: [], ecosystems: [], notes: [] }), 'utf8');
    assert.equal(row(await rowsFor(f), 'INV-CTX-01').status, 'fail');
    writeFileSync(
      join(f.runDir, 'stack.json'),
      JSON.stringify({ languages: [], dependencies: [], ecosystems: [], notes: ['Linguist data unavailable — language tags skipped'] }),
      'utf8',
    );
    assert.equal(row(await rowsFor(f), 'INV-CTX-01').status, 'pass');
  } finally {
    f.cleanup();
  }
});

test('verify — a pass reporting MCP usage fails INV-CTX-05 despite process-level denial', async () => {
  const f = healthyRun();
  try {
    writeFileSync(
      join(f.runDir, 'capability-pack_security.json'),
      JSON.stringify({ reviewer: 'pack/security', available: ['github'], attempted: ['github'], used: ['github'], notes: '' }),
      'utf8',
    );
    const rows = await rowsFor(f);
    const ctx5 = row(rows, 'INV-CTX-05');
    assert.equal(ctx5.status, 'fail');
    assert.match(ctx5.evidence, /reaching MCP/);
  } finally {
    f.cleanup();
  }
});

/** Mark `.claude/skills/team-rules.md` as changed by the PR under review. */
function changeRuleFile(f: Fixture) {
  const gatherPath = join(f.runDir, 'pr-review-gather.json');
  const gather = JSON.parse(readFileSync(gatherPath, 'utf8'));
  gather.changedFiles.push({ path: '.claude/skills/team-rules.md', status: 'modified', additions: 1, deletions: 0, patch: PATCH });
  gather.metadata.changedFileCount = 2;
  writeFileSync(gatherPath, JSON.stringify(gather), 'utf8');
  f.metadata = { ...f.metadata, changedFileCount: 2 } as PrMetadata;
}

/**
 * passes.json records an ABSOLUTE source path while the diff is repo-relative.
 * The fixture uses the real shape on purpose: with a repo-relative source these
 * assertions pass against a comparison that can never match in production.
 */
function routeSource(f: Fixture, absoluteSource: string) {
  writeFileSync(
    join(f.runDir, 'passes.json'),
    JSON.stringify([
      { name: 'pack/security', matchedBy: 'baseline', source: 'C:\\packs\\security.md' },
      { name: 'team-rules', matchedBy: 'context', source: absoluteSource },
    ]),
    'utf8',
  );
}

test('verify — a PR-authored rule that reached the review fails INV-TRUST-01', async () => {
  const f = healthyRun();
  try {
    changeRuleFile(f);
    routeSource(f, 'C:\\repo\\.claude\\skills\\team-rules.md');
    const trust = row(await rowsFor(f), 'INV-TRUST-01');
    assert.equal(trust.status, 'fail');
    assert.match(trust.evidence, /PR-authored rule file/);
  } finally {
    f.cleanup();
  }
});

test('verify — a pack skill whose path merely ends the same way is not the repo rule', async () => {
  const f = healthyRun({ repoRoot: 'C:\\repo' });
  try {
    changeRuleFile(f);
    // Same tail, different tree. Without the repoRoot anchor a suffix match
    // would blame the pack for a rule the PR changed in the checkout.
    routeSource(f, 'C:\\Users\\me\\.pr-review\\packs\\x\\.claude\\skills\\team-rules.md');
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-TRUST-01').status, 'pass');
    assert.match(row(rows, 'INV-TRUST-01').evidence, /excluded from the review/);
  } finally {
    f.cleanup();
  }
});

test('verify — with a known repo root, the PR-authored rule is still caught', async () => {
  const f = healthyRun({ repoRoot: 'C:\\repo' });
  try {
    changeRuleFile(f);
    routeSource(f, 'C:\\repo\\.claude\\skills\\team-rules.md');
    assert.equal(row(await rowsFor(f), 'INV-TRUST-01').status, 'fail');
  } finally {
    f.cleanup();
  }
});

test('verify — a run that refused before pass selection is not graded on what it never reached', async () => {
  const f = healthyRun({ errorTxt: true });
  try {
    // The early-exit gate (too many files, diff too large) fires before stack
    // detection and pass selection, so those artifacts and the plan are absent
    // by design. Reporting three FAILs for a correct refusal is how a report
    // teaches people to ignore it.
    for (const artifact of ['stack.json', 'passes.json', 'capabilities.json', 'dispatch-plan.json']) {
      rmSync(join(f.runDir, artifact), { force: true });
    }
    rmSync(controlDirForRun(f.runDir, f.home), { recursive: true, force: true });
    const rows = await rowsFor(f, { offline: true });
    for (const id of ['INV-CTX-01', 'INV-CTX-02', 'INV-OUT-02']) {
      assert.equal(row(rows, id).status, 'skip', `${id} must not fail a run that never reached selection`);
      assert.match(row(rows, id).evidence, /failed before pass selection/);
    }
  } finally {
    f.cleanup();
  }
});

test('verify — with no run-id, the newest run wins by time, not by name', async () => {
  const f = healthyRun();
  try {
    // A run id sorts by provider first, so an alphabetically-later prefix would
    // outrank a genuinely newer run. `local__` vs `github__` is the real pair.
    const runs = join(f.home, '.pr-review', 'runs');
    const older = join(runs, 'local__o__r__x__2020-01-01T00-00-00-000Z');
    mkdirSync(older, { recursive: true });
    writeFileSync(join(older, 'pr-review-gather.json'), readFileSync(join(f.runDir, 'pr-review-gather.json')));
    const past = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(older, past, past);

    const ctx = await loadVerifyContext({ home: f.home, offline: true, providerOverride: stubProvider(f) });
    assert.equal(ctx.runId, RUN_ID, 'the newer github__ run must win over the older local__ one');
  } finally {
    f.cleanup();
  }
});

test('verify — INV-TRUST-01 folds case, because the bypass it exists for was a case difference', async () => {
  const f = healthyRun({ repoRoot: 'C:\\repo' });
  try {
    const path = join(f.runDir, 'pr-review-gather.json');
    const gather = JSON.parse(readFileSync(path, 'utf8'));
    // The real bypass: a PR committing `.Agents/skills` slipped past a
    // case-sensitive check on macOS.
    gather.changedFiles.push({ path: '.Agents/Skills/team-rules.md', status: 'modified', additions: 1, deletions: 0, patch: PATCH });
    gather.metadata.changedFileCount = 2;
    writeFileSync(path, JSON.stringify(gather), 'utf8');
    f.metadata = { ...f.metadata, changedFileCount: 2 } as PrMetadata;
    routeSource(f, 'C:\\repo\\.Agents\\Skills\\team-rules.md');

    const trust = row(await rowsFor(f), 'INV-TRUST-01');
    assert.equal(trust.status, 'fail', 'a case-sensitive audit would SKIP the exact bypass it guards');
  } finally {
    f.cleanup();
  }
});

test('verify — a failed PR read-back is an incomplete audit, not a clean one', async () => {
  const f = healthyRun();
  try {
    const broken = { ...stubProvider(f), fetchExistingComments: async () => { throw new Error('502 upstream'); } } as PrProvider;
    const ctx = await loadVerifyContext({ runId: RUN_ID, home: f.home, providerOverride: broken });
    assert.equal(ctx.liveWindow, null, 'unknown, never empty');
    const rows = runChecks(ctx);
    assert.equal(rows.filter((r) => r.status === 'fail').length, 0, 'an unreadable PR is not a violation');
    // …but it must not grade as clean either: exit 0 would tell CI that posting
    // was checked when nothing about posting was checked.
    assert.match(row(rows, 'INV-POST-01').evidence, /could not be read back/);
  } finally {
    f.cleanup();
  }
});

/**
 * A check with no failing-path test can be passing vacuously and no one would
 * know. One mutation per remaining check, each asserting the row it targets
 * flips and — for the artifact rows — that it flips for the stated reason.
 */
test('verify — INV-POST-03 catches a severity prefix on a posted body', async () => {
  const f = healthyRun();
  try {
    f.comments.push(comment({ body: 'HIGH: something is wrong here', file: 'src/a.ts', line: 2 }));
    const three = row(await rowsFor(f), 'INV-POST-03');
    assert.equal(three.status, 'fail');
    assert.match(three.evidence, /severity prefix or bot chrome/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-POST-07 catches findings that were neither posted nor reported', async () => {
  const f = healthyRun();
  try {
    // Two findings retained, one attempted: the difference is in no tally.
    writePostedMarker(f.runDir, { posted: 1, attempted: 1, verified: true }, f.home);
    const seven = row(await rowsFor(f), 'INV-POST-07');
    assert.equal(seven.status, 'fail');
    assert.match(seven.evidence, /neither posted nor reported/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-POST-07 catches an unverified publish', async () => {
  const f = healthyRun();
  try {
    writePostedMarker(f.runDir, { posted: 2, attempted: 2, verified: false }, f.home);
    assert.equal(row(await rowsFor(f), 'INV-POST-07').status, 'fail');
  } finally {
    f.cleanup();
  }
});

test('verify — INV-FETCH-02 catches a gather that lost the PR metadata or the patches', async () => {
  const f = healthyRun();
  try {
    const path = join(f.runDir, 'pr-review-gather.json');
    const gather = JSON.parse(readFileSync(path, 'utf8'));
    delete gather.changedFiles[0].patch;
    writeFileSync(path, JSON.stringify(gather), 'utf8');
    const two = row(await rowsFor(f), 'INV-FETCH-02');
    assert.equal(two.status, 'fail');
    assert.match(two.evidence, /carries a patch/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-FETCH-02 does NOT claim to catch a prior comment the gather missed', async () => {
  const f = healthyRun();
  try {
    // The live read is scoped with `since`, so a comment older than the window
    // never comes back and such a clause could never fire. Pinning the absence
    // deliberately: a check that cannot fail is worse than no check, because it
    // reads as coverage. Restoring it would need a second, unscoped fetch of
    // the PR's whole comment history on every audit.
    f.comments.push(comment({ body: 'discussed already', file: 'src/a.ts', line: 2, createdAt: '2023-12-31T00:00:00.000Z' }));
    const two = row(await rowsFor(f), 'INV-FETCH-02');
    assert.equal(two.status, 'pass');
    assert.doesNotMatch(two.evidence, /older than the gather/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-CTX-03 catches zero passes that did not exit 2', async () => {
  const f = healthyRun();
  try {
    writeFileSync(join(f.runDir, 'passes.json'), JSON.stringify([{ name: 'x', matchedBy: 'index' }]), 'utf8');
    const three = row(await rowsFor(f), 'INV-CTX-03');
    assert.equal(three.status, 'fail');
    assert.match(three.evidence, /empty review rendered as a clean PR/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-CTX-04 catches a project skill that consumed a pass slot', async () => {
  const f = healthyRun();
  try {
    // `pack/security` is planned for dispatch; routing it as context means a
    // project skill took a slot instead of injecting everywhere.
    writeFileSync(
      join(f.runDir, 'passes.json'),
      JSON.stringify([{ name: 'pack/security', matchedBy: 'context', source: 'x' }]),
      'utf8',
    );
    const four = row(await rowsFor(f), 'INV-CTX-04');
    assert.equal(four.status, 'fail');
    assert.match(four.evidence, /consumed a pass slot/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-DEL-02 catches more than one initial dispatch session', async () => {
  // Two initial sessions means Phase 1 dispatched twice — the single-session
  // guarantee gone, and the second one's accounting unowned.
  const f = healthyRun({
    mutateState: (state) => {
      state.runtimeAttempts = [...state.runtimeAttempts, { ...state.runtimeAttempts[0]!, number: 2 }];
    },
  });
  try {
    const two = row(await rowsFor(f), 'INV-DEL-02');
    assert.equal(two.status, 'fail');
    assert.match(two.evidence, /Phase 1 must dispatch exactly once/);
  } finally {
    f.cleanup();
  }
});

test('verify — INV-OUT-01 catches exit 2 with no error.txt, and exit 0 with a stale one', async () => {
  const unnamed = healthyRun({ exitCode: 2 });
  try {
    const row1 = row(await rowsFor(unnamed), 'INV-OUT-01');
    assert.equal(row1.status, 'fail');
    assert.match(row1.evidence, /without error\.txt/);
  } finally {
    unnamed.cleanup();
  }
  const stale = healthyRun({ exitCode: 0, errorTxt: true });
  try {
    const row2 = row(await rowsFor(stale), 'INV-OUT-01');
    assert.equal(row2.status, 'fail');
    assert.match(row2.evidence, /stale failure was not cleared/);
  } finally {
    stale.cleanup();
  }
});

test('verify — INV-FETCH-03 cannot be broken through the writer: the plan refuses to be written at all', () => {
  // Not a gap in coverage — the stronger result. `writeDispatchPlan` validates
  // the same containment before signing, so a plan naming a path outside its
  // run dir never reaches disk. The verify row is the second line of defence,
  // for a control store that was corrupted after the fact.
  assert.throws(
    () =>
      healthyRun({
        mutatePlan: (plan) => {
          plan.artifacts = [{ path: join(tmpdir(), 'elsewhere.md'), sha256: 'x' }];
        },
      }),
    /path outside its run directory/,
  );
});

/**
 * Azure DevOps is the one provider where a location-less finding legitimately
 * reaches the top level, as a resolvable PR-level thread (INV-POST-01 says so).
 * Every other fixture here is GitHub, so without these the ADO path would be
 * graded by a rule written for a different provider.
 */
function adoRun(over: Parameters<typeof healthyRun>[0] = {}): Fixture {
  const f = healthyRun({
    ...over,
    findings: [
      { severity: 'HIGH', title: 'one', body: 'first finding body', file: 'src/a.ts', line: 2 },
      { severity: 'LOW', title: 'no location', body: 'a repo-wide observation' },
    ],
  });
  const path = join(f.runDir, 'pr-review-gather.json');
  const gather = JSON.parse(readFileSync(path, 'utf8'));
  gather.pr.provider = 'azuredevops';
  writeFileSync(path, JSON.stringify(gather), 'utf8');
  f.comments = [
    comment({ body: 'first finding body', file: 'src/a.ts', line: 2 }),
    comment({ body: 'a repo-wide observation' }), // the PR-level thread
  ];
  return f;
}

test('verify — on Azure DevOps a PR-level thread for a location-less finding is expected, not a summary comment', async () => {
  const f = adoRun();
  try {
    const rows = await rowsFor(f);
    assert.equal(row(rows, 'INV-POST-02').status, 'pass', 'the documented ADO behaviour must not read as a summary comment');
    const one = row(rows, 'INV-POST-01');
    assert.equal(one.status, 'pass');
    assert.match(one.evidence, /1\/1 as PR-level threads/);
  } finally {
    f.cleanup();
  }
});

test('verify — on Azure DevOps a location-less finding that never landed still FAILs INV-POST-01', async () => {
  const f = adoRun();
  try {
    // Exempting the ADO case instead of expecting it would have left this
    // finding unverified in both directions.
    f.comments = f.comments.filter((c) => c.file);
    const one = row(await rowsFor(f), 'INV-POST-01');
    assert.equal(one.status, 'fail');
    assert.match(one.evidence, /never landed as a PR-level thread/);
  } finally {
    f.cleanup();
  }
});

test('verify — a verdict banner is a violation on Azure DevOps too', async () => {
  const f = adoRun();
  try {
    f.comments.push(comment({ body: '### Code review\n\nLooks good overall.' }));
    const two = row(await rowsFor(f), 'INV-POST-02');
    assert.equal(two.status, 'fail', 'the shape tripwire is provider-independent');
  } finally {
    f.cleanup();
  }
});

test('verify — on GitHub a top-level comment matching a finding body is still a violation', async () => {
  const f = healthyRun();
  try {
    f.comments.push(comment({ body: 'first finding body' })); // no file → top level
    assert.equal(row(await rowsFor(f), 'INV-POST-02').status, 'fail');
  } finally {
    f.cleanup();
  }
});

test('verify — delivery state that failed authentication is not "legacy run"', async () => {
  const f = healthyRun();
  try {
    // The run-dir mirror survives; the authenticated copy does not. That is
    // tampering, and INV-DEL-01 is the row that must not read it as history.
    rmSync(controlDirForRun(f.runDir, f.home), { recursive: true, force: true });
    const del1 = row(await rowsFor(f, { offline: true }), 'INV-DEL-01');
    assert.equal(del1.status, 'fail');
    assert.match(del1.evidence, /failed authentication/);
  } finally {
    f.cleanup();
  }
});

test('verify — capabilities.json without runtime is a pre-0.12 run, not a violation', async () => {
  const f = healthyRun();
  try {
    const path = join(f.runDir, 'capabilities.json');
    const caps = JSON.parse(readFileSync(path, 'utf8'));
    delete caps.runtime;
    writeFileSync(path, JSON.stringify(caps), 'utf8');
    const ctx2 = row(await rowsFor(f, { offline: true }), 'INV-CTX-02');
    assert.equal(ctx2.status, 'pass', 'the audit must not open with a false alarm on every existing run');
    assert.match(ctx2.evidence, /predates 0\.12\.0/);
  } finally {
    f.cleanup();
  }
});

test('verify — a pass with missing MCP evidence fails INV-CTX-05 instead of being discarded', async () => {
  const f = healthyRun();
  try {
    writeFileSync(join(f.runDir, 'capability-pack_security.json'), 'not json', 'utf8');
    const ctx5 = row(await rowsFor(f, { offline: true }), 'INV-CTX-05');
    assert.equal(ctx5.status, 'fail');
    assert.match(ctx5.evidence, /missing or invalid MCP evidence/);
  } finally {
    f.cleanup();
  }
});

test('verify — with no window ceiling, a duplicate cannot be blamed on this run', async () => {
  const f = healthyRun();
  try {
    // No finalization record and no marker: nothing bounds the window, so a
    // later run's comments are indistinguishable from this run's.
    rmSync(join(f.runDir, 'posted.marker'), { force: true });
    rmSync(join(controlDirForRun(f.runDir, f.home), 'posted.marker'), { force: true });
    rmSync(join(controlDirForRun(f.runDir, f.home), 'finalization.json'), { force: true });
    f.comments.push(comment({ body: 'first finding body', file: 'src/a.ts', line: 2 }));
    const five = row(await rowsFor(f), 'INV-POST-05');
    assert.equal(five.status, 'skip');
    assert.match(five.evidence, /recorded no completion time/);
  } finally {
    f.cleanup();
  }
});

test('runVerify — exit contract and --json shape, which CI consumes', async () => {
  const f = healthyRun();
  try {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    let code: number;
    try {
      code = await runVerify({ runId: RUN_ID, home: f.home, offline: true, json: true });
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    assert.equal(code, 0, 'a clean run with no FAIL exits 0');
    const report = JSON.parse(chunks.join(''));
    assert.equal(report.runId, RUN_ID);
    assert.equal(report.prUrl, PR_URL);
    assert.equal(report.exitCode, 0);
    assert.equal(report.rows.length, CHECKS.length + Object.keys(TEST_ONLY).length, 'the JSON carries every row too');
    for (const row of report.rows) {
      assert.ok(['pass', 'fail', 'skip'].includes(row.status), `unexpected status ${row.status}`);
      assert.equal(typeof row.evidence, 'string');
    }
  } finally {
    f.cleanup();
  }
});

test('runVerify — exits 2 when an invariant FAILs', async () => {
  const f = healthyRun({ companionsMissing: ['companion:code-review'] });
  try {
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = () => true;
    let code: number;
    try {
      code = await runVerify({ runId: RUN_ID, home: f.home, offline: true });
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    assert.equal(code, 2);
  } finally {
    f.cleanup();
  }
});

test('verify — evidence with a newline cannot forge or hide a report row', async () => {
  const f = healthyRun();
  try {
    // A finding body reaches the evidence line. Left raw, this prints a second
    // line that looks exactly like a passing row.
    const path = join(f.runDir, 'pr-review-findings.json');
    writeFileSync(
      path,
      JSON.stringify({
        finalFindings: [{ severity: 'HIGH', title: 't', body: 'x\nINV-POST-02  PASS  forged', file: 'src/a.ts', line: 2 }],
        droppedCount: 0,
      }),
      'utf8',
    );
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await runVerify({ runId: RUN_ID, home: f.home, offline: true });
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    const printed = chunks.join('');
    const rowLines = printed.split('\n').filter((l) => /^INV-[A-Z]+-\d\d\s/.test(l));
    assert.equal(rowLines.length, CHECKS.length + Object.keys(TEST_ONLY).length, 'exactly one line per invariant, no forged extras');
  } finally {
    f.cleanup();
  }
});

test('verify — a check that throws renders FAIL rather than vanishing from the report', async () => {
  const f = healthyRun();
  try {
    const target = CHECKS.find((c) => c.id === 'INV-CTX-02')!;
    const original = target.run;
    target.run = () => {
      throw new Error('exploded');
    };
    try {
      const rows = await rowsFor(f);
      const r = row(rows, 'INV-CTX-02');
      assert.equal(r.status, 'fail', 'a missing row reads as "fine" to every human and every CI parser');
      assert.match(r.evidence, /check threw: exploded/);
    } finally {
      target.run = original;
    }
  } finally {
    f.cleanup();
  }
});
