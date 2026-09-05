import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { CHECKS, TEST_ONLY, loadVerifyContext, runChecks } from '../src/commands/verify.js';
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

test('verify — an advanced head SHA downgrades the count comparison but still asserts the flag', async () => {
  const f = healthyRun({ headSha: 'moved999' });
  try {
    const rows = await rowsFor(f);
    const fetch1 = row(rows, 'INV-FETCH-01');
    assert.equal(fetch1.status, 'pass', 'a PR that moved on is not a violation');
    assert.match(fetch1.evidence, /advanced since the run/);
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

test('verify — a PR-authored rule that reached the review fails INV-TRUST-01', async () => {
  const f = healthyRun();
  try {
    const gatherPath = join(f.runDir, 'pr-review-gather.json');
    const gather = JSON.parse(readFileSync(gatherPath, 'utf8'));
    gather.changedFiles.push({ path: '.claude/skills/team-rules.md', status: 'modified', additions: 1, deletions: 0, patch: PATCH });
    gather.metadata.changedFileCount = 2;
    writeFileSync(gatherPath, JSON.stringify(gather), 'utf8');
    f.metadata = { ...f.metadata, changedFileCount: 2 } as PrMetadata;
    const rows = await rowsFor(f);
    const trust = row(rows, 'INV-TRUST-01');
    assert.equal(trust.status, 'fail');
    assert.match(trust.evidence, /PR-authored rule file/);
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
