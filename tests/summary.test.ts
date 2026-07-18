import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSummary, summarizeSkills } from '../src/commands/review.js';
import { parseFindingsFile, CATALOG_TARGET, type SkillRoute } from '../src/dispatch/single-session.js';
import type { ReviewerOutput } from '../src/types.js';

function output(over: Partial<ReviewerOutput>): ReviewerOutput {
  return { reviewerName: 'r', model: 'm', findings: [], rawOutput: '', durationMs: 0, exitCode: 0, ...over };
}

test('renderSummary: single-session reviewer (exitCode 0, no error) renders ✓', () => {
  const md = renderSummary('u', [output({ reviewerName: 'security', exitCode: 0 })], [], 0, 1000);
  const row = md.split('\n').find((l) => l.includes('| security |'));
  assert.ok(row, 'security row present');
  assert.ok(row!.includes('✓'), `expected ✓, got: ${row}`);
  assert.ok(!row!.includes('✗'), `unexpected ✗ in: ${row}`);
});

test('renderSummary: a reviewer with an error still renders ✗ with the message', () => {
  const md = renderSummary('u', [output({ reviewerName: 'codex', exitCode: 3, error: 'exited 3' })], [], 0, 1000);
  const row = md.split('\n').find((l) => l.includes('| codex |'));
  assert.ok(row, 'codex row present');
  assert.ok(row!.includes('✗ exited 3'), `expected ✗ exited 3, got: ${row}`);
});

const ROUTING: SkillRoute[] = [
  { skill: 'pp-regras-plano', source: 's1', targets: ['security', 'architecture', 'verifier'] },
  { skill: 'estilo-time', source: 's2', targets: ['quality', 'verifier'] },
  { skill: 'pp-billing', source: 's3', targets: [CATALOG_TARGET] },
];

test('summarizeSkills: counts injected/reviewers/catalog and builds the brief + section', () => {
  const { section, brief } = summarizeSkills(ROUTING);
  assert.equal(brief, '2 skill(s) → 3 reviewer(s) · 1 catalog');
  const text = section.join('\n');
  assert.ok(text.includes('## Skills'));
  assert.ok(text.includes('**Injected:** 2 (into 3 reviewers) · **Catalog (on-demand):** 1'));
  // verifier dropped from the displayed targets
  assert.ok(text.includes('| pp-regras-plano | security, architecture |'), text);
  assert.ok(text.includes('| estilo-time | quality |'), text);
  // catalog skill is counted, never listed by name
  assert.ok(!text.includes('pp-billing'), 'catalog skill must not be listed by name');
});

test('summarizeSkills: an injected skill matching no files/reviewers shows the placeholder', () => {
  const { section } = summarizeSkills([{ skill: 'tsx-only', source: 's', targets: [] }]);
  assert.ok(section.join('\n').includes('| tsx-only | — (no matching files) |'));
});

test('summarizeSkills: transparency note makes clear catalog ≠ ignored', () => {
  // with injected + catalog
  const mixed = summarizeSkills(ROUTING).section.join('\n');
  assert.ok(/available on-demand/.test(mixed) && /not ignored/i.test(mixed), mixed);

  // injected 0 but catalog present — the alarming case
  const onlyCatalog = summarizeSkills([{ skill: 'pp-x', source: 's', targets: [CATALOG_TARGET] }]).section.join('\n');
  assert.ok(/Injected:\*\* 0/.test(onlyCatalog));
  assert.ok(/available on-demand/.test(onlyCatalog) && /Not ignored/i.test(onlyCatalog), onlyCatalog);

  // no skills at all → no note sentence (the "Catalog (on-demand)" label alone doesn't count)
  assert.ok(!/available on-demand/.test(summarizeSkills([]).section.join('\n')));
});

test('renderSummary: includes the Skills section when routing is passed, omits it otherwise', () => {
  const withSkills = renderSummary('u', [output({ reviewerName: 'security' })], [], 0, 1000, undefined, ROUTING);
  assert.ok(withSkills.includes('## Skills'), 'Skills section present');
  assert.ok(withSkills.includes('| pp-regras-plano | security, architecture |'));
  // reviewer table intact and distinct from the skills table
  assert.ok(withSkills.split('\n').some((l) => l.includes('| security |') && l.includes('✓')));

  const noSkills = renderSummary('u', [output({ reviewerName: 'security' })], [], 0, 1000);
  assert.ok(!noSkills.includes('## Skills'), 'no Skills section without routing');
});

test('parseFindingsFile: reviewers from a structured file get exitCode 0 (delivered = success)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prreview-summary-'));
  try {
    const p = join(dir, 'findings.json');
    writeFileSync(p, JSON.stringify({ reviewers: [{ name: 'security', findings: [] }, { name: 'quality', findings: [] }] }), 'utf8');
    const outputs = parseFindingsFile(p, 'm', 500);
    assert.equal(outputs.length, 2);
    assert.ok(outputs.every((o) => o.exitCode === 0), 'all reviewers stamped exitCode 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
