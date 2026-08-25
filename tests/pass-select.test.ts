import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { SkillDefinition } from '../src/types.js';
import { MAX_STACK_PASSES, selectPasses } from '../src/dispatch/pass-select.js';

function packSkill(name: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: `pk/${name}`,
    description: `about ${name}`,
    source: `/packs/pk/${name}.md`,
    body: `body of ${name}`,
    appliesTo: [],
    tags: [],
    pack: 'pk',
    origin: 'pack',
    mode: 'auto',
    ...over,
  };
}

function repoSkill(name: string, over: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `about ${name}`,
    source: `/repo/.claude/skills/${name}.md`,
    body: `body of ${name}`,
    appliesTo: [],
    origin: 'repo',
    ...over,
  };
}

const FILES = [{ path: 'src/main.go' }, { path: 'infra/main.tf', patch: '+resource "aws_s3_bucket" "b" {}' }];

function base(input: Partial<Parameters<typeof selectPasses>[0]> = {}) {
  return selectPasses({
    skills: [],
    catalog: [],
    packSkills: [],
    inScopeFiles: FILES,
    stackTags: ['go', 'golang', 'hcl', 'terraform'],
    baseline: [],
    ...input,
  });
}

test('selectPasses — glob hit via CSV-parsed applyTo; match-all is never a glob hit', () => {
  const go = packSkill('go', { appliesTo: ['**/*.go', '**/go.mod'] });
  const generic = packSkill('code-review-generic', { appliesTo: ['**'] });
  const sel = base({ packSkills: [go, generic], baseline: ['pk/code-review-generic'] });
  const goPass = sel.passes.find((p) => p.name === 'pk/go')!;
  assert.equal(goPass.matchedBy, 'glob');
  // Extension-only glob + stack-consistent identity: matchedOn carries both signals.
  assert.deepEqual(goPass.matchedOn, ['go', '**/*.go']);
  const gen = sel.passes.find((p) => p.name === 'pk/code-review-generic')!;
  assert.equal(gen.matchedBy, 'baseline', 'applyTo ** falls through to the baseline pointer');
});

test('selectPasses — a promiscuous extension glob without stack identity is demoted to the index', () => {
  // Observed live: awesome-copilot astro/nestjs/svelte/wordpress all claim **/*.ts.
  const astro = packSkill('astro', { appliesTo: ['**/*.ts', '**/*.md'] });
  const csharp = packSkill('csharp', { appliesTo: ['**/*.cs'] });
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [astro, csharp],
    inScopeFiles: [{ path: 'src/app.ts' }, { path: 'src/Api.cs' }],
    stackTags: ['typescript', 'ts', 'c#', 'csharp'],
    baseline: [],
  });
  assert.ok(!sel.passes.some((p) => p.name === 'pk/astro'), 'astro has no stack identity here → index');
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/astro'));
  // The brace form is still extension-only matching (observed live: pcf-*/aws-appsync).
  const brace = packSkill('pcf-alm', { appliesTo: ['**/*.{ts,tsx,js,json,xml,pcfproj,csproj,sln}'] });
  const braceSel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [brace],
    inScopeFiles: [{ path: 'src/app.ts' }],
    stackTags: ['typescript', 'ts'],
    baseline: [],
  });
  assert.ok(!braceSel.passes.some((p) => p.name === 'pk/pcf-alm'), 'brace extension glob without identity → index');
  const cs = sel.passes.find((p) => p.name === 'pk/csharp')!;
  assert.equal(cs.matchedBy, 'glob', 'csharp is stack-consistent → its extension glob counts');
});

test('selectPasses — a specific glob (filename/dir/compound) counts on its own, no identity needed', () => {
  const agentSkills = packSkill('agent-skills', { appliesTo: ['**/skills/**/SKILL.md'] });
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [agentSkills],
    inScopeFiles: [{ path: 'skills/help/SKILL.md' }],
    stackTags: [],
    baseline: [],
  });
  assert.equal(sel.passes.find((p) => p.name === 'pk/agent-skills')?.matchedBy, 'glob');
});

test('selectPasses — exact tag match, never prefixes: java ≠ javascript, terraform hits', () => {
  const java = packSkill('java', { tags: ['java'] });
  const tf = packSkill('terraform-hardening', { tags: ['terraform'] });
  const sel = base({ packSkills: [java, tf], stackTags: ['javascript', 'terraform'] });
  assert.ok(!sel.passes.some((p) => p.name === 'pk/java'), 'java must not match javascript');
  const tfPass = sel.passes.find((p) => p.name === 'pk/terraform-hardening')!;
  assert.equal(tfPass.matchedBy, 'tag');
  assert.deepEqual(tfPass.matchedOn, ['terraform']);
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/java'));
});

test('selectPasses — stack passes capped at MAX_STACK_PASSES, baselines ALWAYS ride, project skills become context', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < 8; i++) packSkills.push(packSkill(`glob-${i}`, { appliesTo: ['**/main.go'] }));
  for (let i = 0; i < 3; i++) packSkills.push(packSkill(`base-${i}`));
  const forced = repoSkill('forced-one', { origin: 'forced' });
  const targeted = repoSkill('team-rules', { appliesTo: ['**/*.go'] });
  const sel = base({
    packSkills,
    skills: [forced, targeted],
    baseline: ['pk/base-0', 'pk/base-1', 'pk/base-2'],
  });
  const kinds = sel.passes.map((p) => p.matchedBy);
  assert.deepEqual(
    kinds,
    ['glob', 'glob', 'glob', 'glob', 'glob', 'glob', 'baseline', 'baseline', 'baseline'],
    'MAX_STACK_PASSES glob + every baseline — baselines can no longer be starved out',
  );
  assert.equal(sel.passes.length, MAX_STACK_PASSES + 3);
  // 2 stack passes overflowed → head of the index
  assert.deepEqual(sel.indexEntries.slice(0, 2).map((e) => e.name), ['pk/glob-6', 'pk/glob-7']);
  // The user's own skills are context in every pass, not pass slots.
  assert.deepEqual(sel.projectSkills.map((s) => s.name).sort(), ['forced-one', 'team-rules']);
  for (const name of ['forced-one', 'team-rules']) {
    assert.equal(sel.routes.find((r) => r.name === name)?.matchedBy, 'context');
  }
});

test('selectPasses — index-only packs never become passes; missing baseline reported (incl. index-mode pointers)', () => {
  const idx = packSkill('detecting-x', { mode: 'index', appliesTo: ['**/*.go'] });
  const sel = base({ packSkills: [idx], baseline: ['pk/renamed-upstream', 'pk/detecting-x'] });
  assert.equal(sel.passes.length, 0);
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/detecting-x'));
  // A pointer into an index-mode pack can never dispatch — reported as missing too.
  assert.deepEqual(sel.missingBaseline.sort(), ['pk/detecting-x', 'pk/renamed-upstream']);
});

test('selectPasses — a baseline that stack-matches but loses the stack cap STILL dispatches as baseline', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < MAX_STACK_PASSES; i++) {
    // Stronger stack hits (2 matchedOn each) that fill the whole cap.
    packSkills.push(packSkill(`strong-${i}`, { appliesTo: ['**/main.go', 'infra/main.tf'] }));
  }
  // The baseline ALSO glob-matches (1 hit) — it loses the cap tie-break…
  const dual = packSkill('security-and-owasp', { appliesTo: ['**/main.go'] });
  const sel = base({ packSkills: [...packSkills, dual], baseline: ['pk/security-and-owasp'] });
  const row = sel.passes.find((p) => p.name === 'pk/security-and-owasp');
  // …but must never be silently evicted: it rides as a baseline pass.
  assert.equal(row?.matchedBy, 'baseline', 'evicted stack hit falls back to its baseline seat');
  assert.equal(sel.passes.length, MAX_STACK_PASSES + 1);
  assert.ok(!sel.indexEntries.some((e) => e.name === 'pk/security-and-owasp'), 'not double-listed in the index');
});

test('selectPasses — repo skills: targeted globs route as glob, untargeted go through the heuristic', () => {
  const targeted = repoSkill('auth-rules', { appliesTo: ['**/*.go'] });
  const missed = repoSkill('css-rules', { appliesTo: ['**/*.css'] });
  // Heuristic needles match 4-char stems of the changed paths/diff: 'infra'/'main'/'resources'/'buckets' clear THRESHOLD.
  const relevant = repoSkill('infra-conventions', { description: 'conventions for infra modules: main terraform resources and s3 buckets' });
  const unrelated = repoSkill('billing-glossary', { description: 'billing domain terms' });
  const sel = base({ skills: [targeted, missed], catalog: [relevant, unrelated] });
  assert.equal(sel.passes.find((p) => p.name === 'auth-rules')?.matchedBy, 'glob');
  assert.equal(sel.passes.find((p) => p.name === 'infra-conventions')?.matchedBy, 'repo');
  assert.ok(!sel.passes.some((p) => p.name === 'css-rules'));
  assert.ok(sel.indexEntries.some((e) => e.name === 'css-rules'));
  assert.ok(sel.indexEntries.some((e) => e.name === 'billing-glossary'));
});

test('selectPasses — baseline dedupe keeps the higher tier; description capped in index entries', () => {
  const dual = packSkill('security-and-owasp', { appliesTo: ['**/main.go'] });
  const longDesc = packSkill('wordy', { description: 'x'.repeat(500) });
  const sel = base({ packSkills: [dual, longDesc], baseline: ['pk/security-and-owasp'] });
  const rows = sel.passes.filter((p) => p.name === 'pk/security-and-owasp');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.matchedBy, 'glob');
  const entry = sel.indexEntries.find((e) => e.name === 'pk/wordy')!;
  assert.equal(entry.description.length, 200);
});

test('selectPasses — project skills never consume pass slots; heuristic-matched ones inject as context', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < 10; i++) packSkills.push(packSkill(`pg-${i}`, { appliesTo: ['**/main.go'] }));
  // Untargeted repo skill promoted by the relevance heuristic (4 stem hits clear THRESHOLD).
  const mine = repoSkill('infra-conventions', { description: 'conventions for infra modules: main terraform resources and s3 buckets' });
  const sel = base({ packSkills, catalog: [mine] });
  assert.ok(!sel.passes.some((p) => p.name === 'infra-conventions'), 'not a pass slot');
  assert.deepEqual(sel.projectSkills.map((s) => s.name), ['infra-conventions']);
  assert.equal(sel.passes.length, MAX_STACK_PASSES, 'stack cap unaffected by project skills');
  assert.equal(sel.routes.find((r) => r.name === 'infra-conventions')?.matchedBy, 'context');
});

test('selectPasses — fallback with no pack passes: project skills become the passes themselves', () => {
  const targeted = repoSkill('db-access-layer', { appliesTo: ['src/**/*.go'] });
  const heuristic = repoSkill('infra-conventions', { description: 'conventions for infra modules: main terraform resources and s3 buckets' });
  const sel = base({ skills: [targeted], catalog: [heuristic], packSkills: [] });
  assert.deepEqual(sel.passes.map((p) => p.name).sort(), ['db-access-layer', 'infra-conventions']);
  assert.deepEqual(sel.projectSkills, [], 'promoted — no separate context set');
  assert.equal(sel.passes.find((p) => p.name === 'db-access-layer')?.matchedBy, 'glob');
  assert.equal(sel.passes.find((p) => p.name === 'infra-conventions')?.matchedBy, 'repo');
});

test('selectPasses — the skill file’s own .md extension is never identity: a changed README must not tag-match every pack skill', () => {
  // Every pack file ends in .md and Linguist aliases Markdown as 'md' — without
  // stripping the extension, one changed README.md made all 604 awesome-copilot
  // skills tag-match and evicted every baseline (observed live).
  const clojure = packSkill('clojure', { source: '/packs/pk/clojure.instructions.md' });
  const baseline = packSkill('code-review-generic');
  const sel = selectPasses({
    skills: [],
    catalog: [],
    packSkills: [clojure, baseline],
    inScopeFiles: [{ path: 'README.md' }, { path: 'src/app.ts' }],
    stackTags: ['md', 'markdown', 'typescript', 'ts'],
    baseline: ['pk/code-review-generic'],
  });
  assert.ok(!sel.passes.some((p) => p.name === 'pk/clojure'), '.md extension must not count as identity');
  assert.equal(sel.passes.find((p) => p.name === 'pk/code-review-generic')?.matchedBy, 'baseline', 'baseline survives');
});

test('selectPasses — within a tier, more matchedOn evidence wins the tie-break', () => {
  const narrow = packSkill('narrow', { appliesTo: ['**/main.go'] });
  const wide = packSkill('wide', { appliesTo: ['**/main.go', 'infra/main.tf'] });
  const sel = base({ packSkills: [narrow, wide] });
  assert.deepEqual(sel.passes.map((p) => p.name), ['pk/wide', 'pk/narrow']);
});

test('selectPasses — routes mirror passes + index', () => {
  const go = packSkill('go', { appliesTo: ['**/*.go'] });
  const idle = packSkill('idle');
  const sel = base({ packSkills: [go, idle] });
  assert.deepEqual(
    sel.routes.map((r) => `${r.name}:${r.matchedBy}`).sort(),
    ['pk/go:glob', 'pk/idle:index'],
  );
});
