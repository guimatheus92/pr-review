import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSummary, summarizePasses } from '../src/commands/review.js';
import { parseFindingsFile } from '../src/dispatch/single-session.js';
import type { PassRoute } from '../src/dispatch/pass-select.js';
import type { ReviewerOutput } from '../src/types.js';

function output(over: Partial<ReviewerOutput>): ReviewerOutput {
  return { reviewerName: 'r', model: 'm', findings: [], rawOutput: '', durationMs: 0, exitCode: 0, ...over };
}

test('renderSummary: single-session reviewer (exitCode 0, no error) renders ✓', () => {
  const md = renderSummary('u', [output({ reviewerName: 'owasp/nodejs-security', exitCode: 0 })], [], 0, 1000);
  const row = md.split('\n').find((l) => l.includes('| owasp/nodejs-security |'));
  assert.ok(row, 'pass row present');
  assert.ok(row!.includes('✓'), `expected ✓, got: ${row}`);
  assert.ok(!row!.includes('✗'), `unexpected ✗ in: ${row}`);
});

test('renderSummary: a reviewer with an error still renders ✗ with the message', () => {
  const md = renderSummary('u', [output({ reviewerName: 'codex', exitCode: 3, error: 'exited 3' })], [], 0, 1000);
  const row = md.split('\n').find((l) => l.includes('| codex |'));
  assert.ok(row, 'codex row present');
  assert.ok(row!.includes('✗ exited 3'), `expected ✗ exited 3, got: ${row}`);
});

const ROUTING: PassRoute[] = [
  { name: 'awesome-copilot/go', source: 's1', matchedBy: 'glob' },
  { name: 'owasp/error-handling', source: 's2', matchedBy: 'baseline' },
  { name: 'anthropic-cybersecurity/detecting-x', source: 's3', matchedBy: 'index' },
];

test('summarizePasses: counts passes/index and builds the brief + section', () => {
  const { section, brief } = summarizePasses(ROUTING);
  assert.equal(brief, '2 pass(es) · 1 on-demand');
  const text = section.join('\n');
  assert.ok(text.includes('## Skills'));
  assert.ok(text.includes('**Passes:** 2 · **On-demand (index):** 1'));
  assert.ok(text.includes('| awesome-copilot/go | glob |'), text);
  assert.ok(text.includes('| owasp/error-handling | baseline |'), text);
  // index skill is counted, never listed as a pass row
  assert.ok(!text.includes('| anthropic-cybersecurity/detecting-x |'), 'index skill must not be a pass row');
});

test('summarizePasses: skipped passes are counted separately, never as passes', () => {
  const { section, brief } = summarizePasses([
    { name: 'p/one', source: 's', matchedBy: 'tag' },
    { name: 'p/two', source: 's', matchedBy: 'skipped' },
  ]);
  const text = section.join('\n');
  assert.equal(brief, '1 pass(es) · 0 on-demand');
  assert.ok(text.includes('**Skipped:** 1'));
  assert.ok(!text.includes('| p/two |'));
});

test('summarizePasses: no skills at all still renders the zero totals (a run with no passes says so)', () => {
  const text = summarizePasses([]).section.join('\n');
  assert.ok(text.includes('## Skills'));
  assert.ok(text.includes('**Passes:** 0 · **On-demand (index):** 0'));
});

test('summarizePasses: transparency note makes clear indexed ≠ ignored', () => {
  const mixed = summarizePasses(ROUTING).section.join('\n');
  assert.ok(/skills-index\.md/.test(mixed) && /not ignored/i.test(mixed), mixed);
  // no index entries → no note sentence
  assert.ok(!/skills-index\.md/.test(summarizePasses([{ name: 'p', source: 's', matchedBy: 'glob' }]).section.join('\n')));
});

test('renderSummary: includes the Skills section when routing is passed, omits it otherwise', () => {
  const withSkills = renderSummary('u', [output({ reviewerName: 'awesome-copilot/go' })], [], 0, 1000, undefined, ROUTING);
  assert.ok(withSkills.includes('## Skills'), 'Skills section present');
  assert.ok(withSkills.includes('| awesome-copilot/go | glob |'));
  // reviewer table intact and distinct from the skills table
  assert.ok(withSkills.split('\n').some((l) => l.includes('| awesome-copilot/go |') && l.includes('✓')));

  const noSkills = renderSummary('u', [output({ reviewerName: 'p/one' })], [], 0, 1000);
  assert.ok(!noSkills.includes('## Skills'), 'no Skills section without routing');
});

test('parseFindingsFile: reviewers from a structured file get exitCode 0 (delivered = success)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prreview-summary-'));
  try {
    const p = join(dir, 'findings.json');
    writeFileSync(p, JSON.stringify({ reviewers: [{ name: 'awesome-copilot/go', findings: [] }, { name: 'verifier', findings: [] }] }), 'utf8');
    const outputs = parseFindingsFile(p, 'm', 500);
    assert.equal(outputs.length, 2);
    assert.ok(outputs.every((o) => o.exitCode === 0), 'all reviewers stamped exitCode 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
