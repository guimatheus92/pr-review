import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSessionContext } from '../src/dispatch/single-session.js';
import type { GatherOutput, SkillDefinition } from '../src/types.js';

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

function baseOpts(outDir: string, paths: string[], skills: SkillDefinition[]) {
  return {
    prUrl: 'https://github.com/o/r/pull/1',
    gather: fixtureGather(paths),
    skills,
    installedCompanions: [],
    skipReviewers: [],
    outDir,
    invokeCompanions: false,
  };
}

test('skill routing — inject_into and applies_to filter per reviewer; verifier gets the union', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const skills: SkillDefinition[] = [
      { name: 'sec-rules', source: 's1.md', body: 'security rules body', appliesTo: ['**/*.ts'], injectInto: ['security'] },
      { name: 'global-rules', source: 's2.md', body: 'global rules body', appliesTo: [] },
      { name: 'frontend-only', source: 's3.md', body: 'frontend body', appliesTo: ['**/*.tsx'] },
    ];
    const ctx = prepareSessionContext(baseOpts(outDir, ['src/app.ts'], skills));

    const secFile = join(outDir, 'skills-security.md');
    assert.ok(existsSync(secFile), 'skills-security.md should exist');
    const secBody = readFileSync(secFile, 'utf8');
    assert.ok(secBody.includes('security rules body'));
    assert.ok(secBody.includes('global rules body'));
    assert.ok(!secBody.includes('frontend body'), 'no .tsx files changed — frontend skill excluded');

    const qualityFile = readFileSync(join(outDir, 'skills-quality.md'), 'utf8');
    assert.ok(!qualityFile.includes('security rules body'), 'inject_into: [security] must not reach quality');
    assert.ok(qualityFile.includes('global rules body'));

    const verifierFile = readFileSync(join(outDir, 'skills-verifier.md'), 'utf8');
    assert.ok(verifierFile.includes('security rules body'), 'verifier gets the union');

    const secRoute = ctx.skillRouting.find((r) => r.skill === 'sec-rules')!;
    assert.deepEqual(secRoute.targets.filter((t) => t !== 'verifier'), ['security']);
    const frontendRoute = ctx.skillRouting.find((r) => r.skill === 'frontend-only')!;
    assert.equal(frontendRoute.targets.length, 0);

    const contextBody = readFileSync(ctx.contextPath, 'utf8');
    assert.ok(!contextBody.includes('security rules body'), 'skills no longer live in the shared context file');
    assert.ok(contextBody.includes('UNTRUSTED-COMMENTS'), 'existing comments are fenced');

    assert.ok(ctx.orchestratorPrompt.includes('skills-security.md'));
    assert.ok(ctx.orchestratorPrompt.includes('phase1-findings.json'));
    assert.ok(ctx.orchestratorPrompt.includes('CRITICAL or HIGH'), 'verifier dispatch is conditional');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('triage — docs-only PR dispatches only quality', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(baseOpts(outDir, ['README.md', 'docs/guide.md'], []));
    assert.deepEqual(ctx.dispatchedReviewers, ['quality']);
    assert.ok(ctx.triageSkipped.includes('security'));
    assert.ok(!ctx.orchestratorPrompt.includes('pr-review:security'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('triage — mixed PR dispatches everything', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext(baseOpts(outDir, ['README.md', 'src/app.ts'], []));
    assert.equal(ctx.triageSkipped.length, 0);
    assert.ok(ctx.dispatchedReviewers.includes('security'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('skill body cap — oversized skill is truncated with a marker', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const skills: SkillDefinition[] = [
      { name: 'huge', source: 'huge.md', body: 'x'.repeat(20_000), appliesTo: [] },
    ];
    prepareSessionContext(baseOpts(outDir, ['src/app.ts'], skills));
    const qualityFile = readFileSync(join(outDir, 'skills-quality.md'), 'utf8');
    assert.ok(qualityFile.includes('[truncated: skill body exceeded 16 KB]'));
    assert.ok(qualityFile.length < 20_000);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('language directive lands in the context file when not en', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], []), language: 'pt-BR' });
    const body = readFileSync(ctx.contextPath, 'utf8');
    assert.ok(body.includes('pt-BR'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('runtime — claude prompt uses Task(subagent_type=...), copilot uses task(agent_type=...)', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const claude = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], []), runtime: 'claude' as const });
    assert.ok(claude.orchestratorPrompt.includes('Task(subagent_type="pr-review:quality"'));
    assert.ok(claude.orchestratorPrompt.includes('Use the `Task` tool'));
    const copilot = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], []), runtime: 'copilot' as const });
    assert.ok(copilot.orchestratorPrompt.includes('task(agent_type="pr-review:quality"'));
    assert.ok(!copilot.orchestratorPrompt.includes('subagent_type'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('includeCodex — writes skills-codex.md and exposes it in skillsFiles', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const skills: SkillDefinition[] = [
      { name: 'global-rules', source: 's.md', body: 'global body', appliesTo: [] },
      { name: 'codex-only', source: 'c.md', body: 'codex body', appliesTo: [], injectInto: ['codex'] },
    ];
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], skills), includeCodex: true });
    assert.ok(ctx.skillsFiles['codex'], 'skills-codex.md path exposed');
    const body = readFileSync(ctx.skillsFiles['codex']!, 'utf8');
    assert.ok(body.includes('global body'));
    assert.ok(body.includes('codex body'));
    const qualityBody = readFileSync(ctx.skillsFiles['quality']!, 'utf8');
    assert.ok(!qualityBody.includes('codex body'), 'inject_into: [codex] must not reach quality');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('companions routing — untargeted skills reach skills-companions.md; inject_into-targeted skills never leak there', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const skills: SkillDefinition[] = [
      { name: 'untargeted', source: 'u.md', body: 'untargeted body', appliesTo: [] },
      { name: 'sec-only', source: 's.md', body: 'sec-only body', appliesTo: [], injectInto: ['security'] },
    ];
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['src/app.ts'], skills),
      installedCompanions: ['pr-review-toolkit'],
      invokeCompanions: true,
    });
    const companionsFile = readFileSync(ctx.skillsFiles['companions']!, 'utf8');
    assert.ok(companionsFile.includes('untargeted body'));
    assert.ok(!companionsFile.includes('sec-only body'), 'inject_into-targeted skill must not leak to companions');
    const verifierFile = readFileSync(ctx.skillsFiles['verifier']!, 'utf8');
    assert.ok(verifierFile.includes('untargeted body'), 'verifier union includes companion skills');
    assert.ok(ctx.orchestratorPrompt.includes('pr-review-toolkit:code-reviewer'), 'companion agents dispatched');
    assert.ok(ctx.orchestratorPrompt.includes('skills-companions.md'));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('BUILTIN_AGENTS registry stays in lockstep with agents/*.md files', async () => {
  const { BUILTIN_AGENTS } = await import('../src/dispatch/single-session.js');
  const { readdirSync } = await import('node:fs');
  const files = readdirSync('agents').filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  const registered = [...BUILTIN_AGENTS.map((a: string) => a.replace(/^pr-review:/, '')), 'verifier'];
  assert.deepEqual(registered.sort(), files.sort(), 'agents/*.md and BUILTIN_AGENTS(+verifier) must match');
});

test('triage guard — docs-only PR with quality skipped never dispatches zero reviewers', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['README.md'], []),
      skipReviewers: ['quality'],
    });
    assert.ok(ctx.dispatchedReviewers.length > 0, 'must not triage down to an empty dispatch');
    assert.equal(ctx.triageSkipped.length, 0, 'triage backs off entirely when its survivor set is empty');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('triage — never triages down to zero: docs-only PR with quality skipped dispatches everything', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const ctx = prepareSessionContext({
      ...baseOpts(outDir, ['README.md', 'docs/guide.md'], []),
      skipReviewers: ['quality'],
    });
    assert.ok(ctx.dispatchedReviewers.length > 0, 'dispatch list must never be empty');
    assert.ok(ctx.dispatchedReviewers.includes('security'));
    assert.equal(ctx.triageSkipped.length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('catalog — renders name/description/path in pr-context.md; body never injected; absent when empty', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const catalog: SkillDefinition[] = [
      { name: 'pp-planos', source: '/abs/.claude/skills/pp-planos/SKILL.md', body: 'CATALOG_BODY_MARKER should never be injected', appliesTo: [], description: 'plan and limit rules' },
    ];
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], []), catalog });
    const contextBody = readFileSync(ctx.contextPath, 'utf8');
    assert.ok(contextBody.includes('## Workspace Skills Catalog'), 'catalog header present');
    assert.ok(contextBody.includes('**pp-planos**'), 'catalog entry name present');
    assert.ok(contextBody.includes('plan and limit rules'), 'catalog description present');
    assert.ok(contextBody.includes('/abs/.claude/skills/pp-planos/SKILL.md'), 'catalog path present');
    assert.ok(!contextBody.includes('CATALOG_BODY_MARKER'), 'catalog body is not injected into pr-context.md');
    for (const f of readdirSync(outDir).filter((n) => n.startsWith('skills-') && n.endsWith('.md'))) {
      assert.ok(!readFileSync(join(outDir, f), 'utf8').includes('CATALOG_BODY_MARKER'), `catalog body must not leak into ${f}`);
    }

    // Control: no catalog → no header.
    const outDir2 = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
    try {
      const ctx2 = prepareSessionContext(baseOpts(outDir2, ['src/app.ts'], []));
      assert.ok(!readFileSync(ctx2.contextPath, 'utf8').includes('## Workspace Skills Catalog'));
    } finally {
      rmSync(outDir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('catalog — routing table rows carry the (catalog — on-demand) target', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const catalog: SkillDefinition[] = [
      { name: 'pp-billing', source: '/abs/.claude/skills/pp-billing.md', body: 'b', appliesTo: [], description: 'billing' },
    ];
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], []), catalog });
    const row = ctx.skillRouting.find((r) => r.skill === 'pp-billing')!;
    assert.deepEqual(row.targets, ['(catalog — on-demand)']);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('catalog caps — description truncates at 200 chars and the section stops with an omitted note', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-ctx-'));
  try {
    const longDesc = 'D'.repeat(1000);
    const catalog: SkillDefinition[] = Array.from({ length: 300 }, (_, i) => ({
      name: `skill-${i}`,
      source: `/abs/.claude/skills/skill-${i}.md`,
      body: 'b',
      appliesTo: [],
      description: longDesc,
    }));
    const ctx = prepareSessionContext({ ...baseOpts(outDir, ['src/app.ts'], []), catalog });
    const contextBody = readFileSync(ctx.contextPath, 'utf8');
    // First entry's description is capped to 200 D's (201 would exceed the cap).
    assert.ok(contextBody.includes(`**skill-0** — ${'D'.repeat(200)} `), 'description truncated at 200 chars');
    assert.ok(!contextBody.includes('D'.repeat(201)), 'no description exceeds 200 chars');
    assert.ok(/\(\+\d+ more skills omitted\)/.test(contextBody), 'overflow note present');
    assert.ok(!contextBody.includes('skill-299'), 'later skills omitted by the section cap');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
