import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSummary } from '../src/commands/review.js';
import { parseFindingsFile } from '../src/dispatch/single-session.js';
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
