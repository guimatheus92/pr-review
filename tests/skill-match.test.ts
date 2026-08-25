import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { selectRelevantSkills } from '../src/dispatch/skill-match.js';
import type { SkillDefinition } from '../src/types.js';

function skill(name: string, description: string): SkillDefinition {
  return { name, description, source: `${name}.md`, body: '', appliesTo: [] };
}

const PLANS_PR = [
  { path: 'src/plans/PlanService.ts', patch: '@@\n+ const ceiling = plan.limit;' },
  { path: 'src/billing/Credits.ts', patch: '@@\n+ chargeCredits(account);' },
];

test('selectRelevantSkills — pt description matches en file paths via shared stem', () => {
  const catalog = [
    skill('pp-planos', 'Regras de teto de cadastro; consultar ao mexer em planos, créditos, billing.'),
    skill('video-editor', 'Video editing helper for trimming and captioning clips.'),
  ];
  const { matched, rest } = selectRelevantSkills(catalog, PLANS_PR);
  assert.deepEqual(matched.map((s) => s.name), ['pp-planos'], 'pt skill matched (planos↔plans, créditos↔credits, billing)');
  assert.deepEqual(rest.map((s) => s.name), ['video-editor'], 'unrelated skill stays in catalog');
});

test('selectRelevantSkills — a skill with no topical overlap is not injected', () => {
  const { matched, rest } = selectRelevantSkills([skill('design-tokens', 'Color and spacing design tokens for the mobile app.')], PLANS_PR);
  assert.equal(matched.length, 0);
  assert.equal(rest.length, 1);
});

test('selectRelevantSkills — no numeric cap: every relevant skill is injected', () => {
  // 15 skills that all match "plans"; ALL inject — project rules are never dropped for budget.
  const catalog = Array.from({ length: 15 }, (_, i) => skill(`plan-rule-${i}`, 'planos e créditos e billing e cadastro'));
  const { matched, rest } = selectRelevantSkills(catalog, PLANS_PR);
  assert.equal(matched.length, 15, 'every relevant skill injected');
  assert.equal(rest.length, 0, 'nothing relevant left behind in the catalog');
});

test('selectRelevantSkills — empty catalog and no files are safe', () => {
  assert.deepEqual(selectRelevantSkills([], PLANS_PR), { matched: [], rest: [] });
  assert.deepEqual(selectRelevantSkills([skill('x', 'planos')], []), { matched: [], rest: [skill('x', 'planos')] });
});
