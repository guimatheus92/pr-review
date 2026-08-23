import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview } from '../src/commands/review.js';
import type { PassSelection } from '../src/dispatch/pass-select.js';
import type { Finding, GatherOutput, PrRef } from '../src/types.js';
import type { PrProvider } from '../src/providers/types.js';

// Fresh-run pipeline without any network: gather comes from --from-gather, the
// pass selection is injected, packs are disabled via a repo yaml in a temp cwd
// (skill_packs REPLACE semantics), and runtime is pinned so PATH is not probed.

function gatherFixture(paths: string[]): GatherOutput {
  return {
    pr: { provider: 'github', url: 'https://github.com/pr-review/eval/pull/1', owner: 'pr-review', repo: 'eval', number: 1 },
    metadata: {
      title: 'Eval PR',
      description: 'A synthetic PR with enough description for the gate.',
      author: 'eval',
      headSha: 'abcdef1234567890',
      baseSha: '1234567890abcdef',
      baseBranch: 'main',
      headBranch: 'eval',
      labels: [],
      linkedItems: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      isDraft: false,
      state: 'open',
    },
    changedFiles: paths.map((p) => ({
      path: p,
      status: 'modified' as const,
      additions: 1,
      deletions: 0,
      patch: '@@ -1,1 +1,2 @@\n context\n+added',
    })),
    fullDiff: '',
    existingComments: [],
    gatheredAt: '2026-01-01T00:00:00Z',
  };
}

function fakeProvider(): PrProvider {
  return {
    name: 'github',
    authEnv: () => ({}),
    parseUrl: (url: string): PrRef => ({ provider: 'github', url, owner: 'pr-review', repo: 'eval', number: 1 }),
    fetchMetadata: async () => gatherFixture([]).metadata,
    fetchChangedFiles: async () => [],
    fetchFullDiff: async () => '',
    fetchExistingComments: async () => [],
    isTransientError: () => false,
    postLineComment: async () => null,
  };
}

function emptySelection(): PassSelection {
  return { passes: [], indexEntries: [], stackTags: ['elixir'], routes: [], missingBaseline: [] };
}

function setup(paths: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'pr-zero-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'pr-zero-cwd-'));
  writeFileSync(join(cwd, '.pr-review.yaml'), 'skill_packs: []\ncompanion_warn: false\n');
  const runDir = mkdtempSync(join(tmpdir(), 'pr-zero-run-'));
  const gatherFile = join(runDir, 'input-gather.json');
  writeFileSync(gatherFile, JSON.stringify(gatherFixture(paths)), 'utf8');
  const prev = process.cwd();
  process.chdir(cwd);
  return {
    cwd,
    home,
    runDir,
    gatherFile,
    restore() {
      process.chdir(prev);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

const BASE = {
  prUrl: 'https://github.com/pr-review/eval/pull/1',
  dryRun: true,
  publish: false,
  withCodex: false,
  withCompanions: false,
  noCompanionWarning: true,
  runtime: 'copilot' as const,
};

test('zero passes on a code PR — exit 2, error.txt written, NO done-state summary file', async () => {
  const s = setup(['lib/app.ex']);
  try {
    const r = await runReview({
      ...BASE,
      homeOverride: s.home,
      runDir: s.runDir,
      fromGather: s.gatherFile,
      provider: fakeProvider(),
      selectPassesFn: () => emptySelection(),
    });
    assert.equal(r.exitCode, 2, 'an empty review is never a clean PR');
    assert.match(r.summary, /nothing to review with — no skills matched/);
    assert.match(r.summary, /stack tags: elixir/);
    assert.match(r.summary, /packs suggest/);
    assert.ok(existsSync(join(s.runDir, 'error.txt')), 'error.txt marks the run failed for status');
    assert.ok(!existsSync(join(s.runDir, 'pr-review-summary.md')), 'no done-state artifact on failure');
  } finally {
    s.restore();
  }
});

test('docs-only PR where triage removes every pass — benign exit 0 with an explanatory summary', async () => {
  const s = setup(['README.md', 'docs/guide.md']);
  try {
    const r = await runReview({
      ...BASE,
      homeOverride: s.home,
      runDir: s.runDir,
      fromGather: s.gatherFile,
      provider: fakeProvider(),
      selectPassesFn: () => ({
        ...emptySelection(),
        passes: [
          { name: 'p/generic', source: '/x.md', body: 'b', matchedBy: 'baseline', matchedOn: [] },
        ],
        routes: [{ name: 'p/generic', source: '/x.md', matchedBy: 'baseline' }],
      }),
    });
    assert.equal(r.exitCode, 0, 'docs-only with nothing doc-scoped is benign');
    assert.match(r.summary, /docs-only PR with no doc-scoped review skill/);
    assert.ok(existsSync(join(s.runDir, 'pr-review-summary.md')), 'done-state summary written');
    assert.ok(!existsSync(join(s.runDir, 'error.txt')));
  } finally {
    s.restore();
  }
});

test('--from-gather without --dry-run throws before any work', async () => {
  const s = setup(['lib/app.ex']);
  try {
    await assert.rejects(
      runReview({
        ...BASE,
        homeOverride: s.home,
        dryRun: false,
        publish: true,
        runDir: s.runDir,
        fromGather: s.gatherFile,
        provider: fakeProvider(),
        selectPassesFn: () => emptySelection(),
      }),
      /--from-gather requires --dry-run/,
    );
  } finally {
    s.restore();
  }
});

test('--context-only with zero passes on a code PR — exit 2 and error.txt, never the done-state summary', async () => {
  const s = setup(['lib/app.ex']);
  try {
    const r = await runReview({
      ...BASE,
      homeOverride: s.home,
      contextOnly: true,
      runDir: s.runDir,
      fromGather: s.gatherFile,
      provider: fakeProvider(),
      selectPassesFn: () => emptySelection(),
    });
    assert.equal(r.exitCode, 2);
    assert.ok(existsSync(join(s.runDir, 'error.txt')), 'preview of a failed selection is error.txt');
    assert.ok(!existsSync(join(s.runDir, 'pr-review-summary.md')), 'no done-state artifact');
    assert.match(r.summary, /## Stack/);
  } finally {
    s.restore();
  }
});

// Issue #5's stack-agnostic checkbox, transplanted: with no agents/*.md left, the
// only review-shaped prompt text in the repo is PASS_RULES, VERIFIER_BRIEF, the
// orchestrator scaffold, and the codex prompt — none may hardcode a framework.
test('prompt text in the repo stays stack-agnostic (no framework names)', async () => {
  const { PASS_RULES, VERIFIER_BRIEF } = await import('../src/dispatch/single-session.js');
  const codexSrc = readFileSync(join(process.cwd(), 'src', 'dispatch', 'codex.ts'), 'utf8');
  const singleSrc = readFileSync(join(process.cwd(), 'src', 'dispatch', 'single-session.ts'), 'utf8');
  const DENY = /\b(React|Vue|Angular|Django|Rails|Spring|Express|Next\.js|Flask|Laravel|Terraform|Kubernetes|Docker)\b/;
  for (const [label, text] of [
    ['PASS_RULES', PASS_RULES],
    ['VERIFIER_BRIEF', VERIFIER_BRIEF],
    ['single-session.ts', singleSrc],
    ['codex.ts', codexSrc],
  ] as const) {
    assert.ok(!DENY.test(text), `${label} must not hardcode framework names`);
  }
});
