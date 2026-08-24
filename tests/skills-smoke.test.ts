import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadAll } from '../src/plugins/loader.js';
import { selectPasses } from '../src/dispatch/pass-select.js';
import { prepareSessionContext } from '../src/dispatch/single-session.js';
import type { GatherOutput } from '../src/types.js';

// End-to-end smoke test for the "skills as passes" core value: a project-specific
// business rule — deliberately UNRELATED to any stack — authored in .claude/skills/
// must be discovered from disk, selected as its own review pass, and written verbatim
// into that pass's context file. This chains loadAll (discovery) → selectPasses
// (selection) → prepareSessionContext (files/prompt) — the three halves the other
// tests cover only in isolation. Fully deterministic: no network, no runtime, no LLM.

const RULE_BODY = `---
name: db-access-layer
description: Mandatory data-access architecture rule for this repo
applies_to:
  - "src/**/*.ts"
---
# Database access rule (MANDATORY — project-specific)

All database access MUST go through \`AccountRepository\` in \`src/db/accountRepository.ts\`.
No module outside \`src/db/\` may import \`pg\` or call \`pool.query(...)\` directly.
Cite this rule by name (db-access-layer) when you flag a violation.
`;

function fixtureGather(paths: string[]): GatherOutput {
  return {
    pr: { provider: 'github', url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 },
    metadata: {
      title: 'Test PR',
      description: 'A test PR with enough description.',
      author: 'tester',
      headSha: 'abcdef1234567890',
      baseSha: '1234567890abcdef',
      baseBranch: 'main',
      headBranch: 'feature',
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

test('skills smoke — a repo business rule flows disk → discovery → its own review pass', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-smoke-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-smoke-home-')); // empty → no global skills, no packs
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-smoke-out-'));
  try {
    const skillsDir = join(cwd, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'db-access-layer.md'), RULE_BODY);

    const { config } = loadConfig({ cwd, homeOverride: home });
    const gather = fixtureGather(['src/orders/service.ts']);
    const loaded = loadAll({ cwd, config, skillsOnly: true, home });
    assert.ok(loaded.skills.some((s) => s.name === 'db-access-layer'), 'targeted rule discovered');
    assert.equal(loaded.packSkills.length, 0, 'no pack checkouts in the empty test home');

    const inScopeFiles = gather.changedFiles.filter((f) => !f.excluded);
    const selection = selectPasses({
      skills: loaded.skills,
      catalog: loaded.catalog,
      packSkills: loaded.packSkills,
      inScopeFiles,
      stackTags: ['typescript'],
      baseline: [],
    });
    const rulePass = selection.passes.find((p) => p.name === 'db-access-layer');
    assert.ok(rulePass, 'the rule becomes its own review pass');
    assert.equal(rulePass!.matchedBy, 'glob');

    const ctx = prepareSessionContext({
      prUrl: 'https://github.com/o/r/pull/1',
      gather,
      passes: selection.passes,
      indexEntries: selection.indexEntries,
      stackTags: selection.stackTags,
      installedCompanions: [],
      skipReviewers: [],
      outDir,
      invokeCompanions: false,
    });

    const CITE = 'AccountRepository'; // distinctive, stack-agnostic phrase from the rule
    const passFile = readFileSync(ctx.skillsFiles['db-access-layer']!, 'utf8');
    assert.ok(passFile.includes(CITE), 'rule body written into its pass file');
    assert.ok(readFileSync(ctx.skillsFiles['all']!, 'utf8').includes(CITE), 'union carries it for codex/verifier');
    assert.ok(ctx.orchestratorPrompt.includes('record as reviewer name `db-access-layer`'));
    assert.equal(ctx.routing.find((r) => r.name === 'db-access-layer')?.matchedBy, 'glob');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('index smoke — an unmatched untargeted skill flows disk → index file, never into a pass; inject_into warns deprecated', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-smoke-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-smoke-home-'));
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-smoke-out-'));
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    const claudeDir = join(cwd, '.claude', 'skills');
    mkdirSync(claudeDir, { recursive: true });
    // Untargeted and unrelated to the changed files → on-demand index, not a pass.
    writeFileSync(
      join(claudeDir, 'video-helper.md'),
      '---\ndescription: video captions and overlays helper\n---\nINDEX_ONLY_MARKER — read on demand.\n',
    );
    // Legacy frontmatter: parsed only to warn — every matched skill is its own pass now.
    writeFileSync(
      join(claudeDir, 'legacy-rule.md'),
      '---\ndescription: legacy targeted rule\napplies_to: ["src/**"]\ninject_into: [security]\n---\nlegacy body\n',
    );

    const { config } = loadConfig({ cwd, homeOverride: home });
    const gather = fixtureGather(['src/orders/service.ts']);
    const loaded = loadAll({ cwd, config, skillsOnly: true, home });
    const selection = selectPasses({
      skills: loaded.skills,
      catalog: loaded.catalog,
      packSkills: loaded.packSkills,
      inScopeFiles: gather.changedFiles,
      stackTags: ['typescript'],
      baseline: [],
    });
    assert.ok(!selection.passes.some((p) => p.name === 'video-helper'), 'unmatched skill is not a pass');
    assert.ok(selection.indexEntries.some((e) => e.name === 'video-helper'), 'it lands in the index');
    assert.ok(
      lines.some((l) => l.includes('inject_into is deprecated')),
      'legacy inject_into frontmatter warns once at load time',
    );
    assert.ok(selection.passes.some((p) => p.name === 'legacy-rule'), 'applies_to still routes the legacy skill');

    const ctx = prepareSessionContext({
      prUrl: 'https://github.com/o/r/pull/1',
      gather,
      passes: selection.passes,
      indexEntries: selection.indexEntries,
      stackTags: selection.stackTags,
      installedCompanions: [],
      skipReviewers: [],
      outDir,
      invokeCompanions: false,
    });
    const index = readFileSync(join(outDir, 'skills-index.md'), 'utf8');
    assert.ok(index.includes('**video-helper**'));
    assert.ok(readFileSync(ctx.contextPath, 'utf8').includes('skills-index.md'), 'pr-context points at the index');
    assert.ok(!existsSync(join(outDir, 'pass-video-helper.md')), 'no pass file for an index skill');
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
