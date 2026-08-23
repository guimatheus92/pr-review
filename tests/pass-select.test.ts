import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { SkillDefinition } from '../src/types.js';
import { MAX_PASSES, selectPasses } from '../src/dispatch/pass-select.js';

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
  assert.deepEqual(goPass.matchedOn, ['**/*.go']);
  const gen = sel.passes.find((p) => p.name === 'pk/code-review-generic')!;
  assert.equal(gen.matchedBy, 'baseline', 'applyTo ** falls through to the baseline pointer');
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

test('selectPasses — order glob > tag > repo > forced > baseline; cap sends overflow to the index head', () => {
  const packSkills: SkillDefinition[] = [];
  for (let i = 0; i < 6; i++) packSkills.push(packSkill(`glob-${i}`, { appliesTo: ['**/*.go'] }));
  for (let i = 0; i < 3; i++) packSkills.push(packSkill(`tag-${i}`, { tags: ['terraform'] }));
  for (let i = 0; i < 3; i++) packSkills.push(packSkill(`base-${i}`));
  const forced = repoSkill('forced-one', { origin: 'forced' });
  const sel = base({
    packSkills,
    skills: [forced],
    baseline: ['pk/base-0', 'pk/base-1', 'pk/base-2'],
  });
  assert.equal(sel.passes.length, MAX_PASSES);
  const kinds = sel.passes.map((p) => p.matchedBy);
  assert.deepEqual(kinds, ['glob', 'glob', 'glob', 'glob', 'glob', 'glob', 'tag', 'tag', 'tag', 'forced']);
  // 3 baseline passes overflowed → head of the index, and routed as 'index'
  assert.deepEqual(sel.indexEntries.slice(0, 3).map((e) => e.name), ['pk/base-0', 'pk/base-1', 'pk/base-2']);
  for (const name of ['pk/base-0', 'pk/base-1', 'pk/base-2']) {
    assert.equal(sel.routes.find((r) => r.name === name)?.matchedBy, 'index');
  }
});

test('selectPasses — index-only packs never become passes; missing baseline reported', () => {
  const idx = packSkill('detecting-x', { mode: 'index', appliesTo: ['**/*.go'] });
  const sel = base({ packSkills: [idx], baseline: ['pk/renamed-upstream'] });
  assert.equal(sel.passes.length, 0);
  assert.ok(sel.indexEntries.some((e) => e.name === 'pk/detecting-x'));
  assert.deepEqual(sel.missingBaseline, ['pk/renamed-upstream']);
});

test('selectPasses — repo skills: targeted globs route as glob, untargeted go through the heuristic', () => {
  const targeted = repoSkill('auth-rules', { appliesTo: ['**/*.go'] });
  const missed = repoSkill('css-rules', { appliesTo: ['**/*.css'] });
  // Heuristic needles match 4-char stems of the changed paths/diff: 'infra' hits 'infra/main.tf'.
  const relevant = repoSkill('infra-conventions', { description: 'conventions for infra modules' });
  const unrelated = repoSkill('billing-glossary', { description: 'billing domain terms' });
  const sel = base({ skills: [targeted, missed], catalog: [relevant, unrelated] });
  assert.equal(sel.passes.find((p) => p.name === 'auth-rules')?.matchedBy, 'glob');
  assert.equal(sel.passes.find((p) => p.name === 'infra-conventions')?.matchedBy, 'repo');
  assert.ok(!sel.passes.some((p) => p.name === 'css-rules'));
  assert.ok(sel.indexEntries.some((e) => e.name === 'css-rules'));
  assert.ok(sel.indexEntries.some((e) => e.name === 'billing-glossary'));
});

test('selectPasses — baseline dedupe keeps the higher tier; description capped in index entries', () => {
  const dual = packSkill('security-and-owasp', { appliesTo: ['**/*.go'] });
  const longDesc = packSkill('wordy', { description: 'x'.repeat(500) });
  const sel = base({ packSkills: [dual, longDesc], baseline: ['pk/security-and-owasp'] });
  const rows = sel.passes.filter((p) => p.name === 'pk/security-and-owasp');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.matchedBy, 'glob');
  const entry = sel.indexEntries.find((e) => e.name === 'pk/wordy')!;
  assert.equal(entry.description.length, 200);
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
