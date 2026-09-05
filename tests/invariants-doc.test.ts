import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, TEST_ONLY } from '../src/commands/verify.js';

/**
 * INVARIANTS.md and the check registry in src/commands/verify.ts are two halves
 * of one contract: the document is authoritative for humans, the registry for
 * the shipped bundle (which must not read a repo file at runtime). This test is
 * the joint.
 *
 * It is what makes the ID rule enforceable: rename an ID in either half and the
 * set equality below fails immediately, instead of the report quietly losing a
 * row — which reads as "fine" to every human and every CI parser.
 */

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DOC = join(REPO_ROOT, 'INVARIANTS.md');

interface DocEntry {
  id: string;
  title: string;
  area: string;
  check: string;
  enforced: string[];
  verified: string[];
}

/** Paths cited in Enforced:/Verified: lines, as `dir/file` tokens. */
function citedPaths(line: string): string[] {
  return [...line.matchAll(/`((?:src|tests|scripts|evals)\/[A-Za-z0-9_./-]*)`/g)].map((m) => m[1]!);
}

function parseDoc(): DocEntry[] {
  const text = readFileSync(DOC, 'utf8');
  const lines = text.split(/\r?\n/);
  const entries: DocEntry[] = [];
  let area = '';
  let current: DocEntry | null = null;
  let field: 'enforced' | 'verified' | null = null;

  for (const line of lines) {
    const section = /^##\s+([A-Z]+)\s/.exec(line);
    if (section) {
      area = section[1]!;
      continue;
    }
    const heading = /^###\s+(INV-[A-Z]+-\d{2})\s+—\s+(.+)$/.exec(line);
    if (heading) {
      current = { id: heading[1]!, title: heading[2]!, area, check: '', enforced: [], verified: [] };
      entries.push(current);
      field = null;
      continue;
    }
    if (!current) continue;
    const check = /^\*\*Check:\*\*\s+(run\+pr|run|tests-only|human)\s*$/.exec(line);
    if (check) {
      current.check = check[1]!;
      field = null;
      continue;
    }
    if (/^\*\*Enforced:\*\*/.test(line)) field = 'enforced';
    else if (/^\*\*Verified:\*\*/.test(line)) field = 'verified';
    else if (/^\*\*(Always|Why|Status):\*\*/.test(line)) field = null;
    if (field) current[field].push(...citedPaths(line));
  }
  return entries;
}

const entries = parseDoc();

test('INVARIANTS.md — parses into well-formed entries', () => {
  assert.ok(existsSync(DOC), 'INVARIANTS.md must exist at the repo root');
  assert.ok(entries.length > 0, 'no invariant blocks parsed — the heading format changed');
  for (const entry of entries) {
    assert.ok(entry.check !== '', `${entry.id} has no **Check:** field`);
    assert.ok(
      entry.id.startsWith(`INV-${entry.area}-`),
      `${entry.id} sits under the "## ${entry.area}" section but does not carry that area prefix`,
    );
  }
  const ids = entries.map((e) => e.id);
  assert.deepEqual([...new Set(ids)], ids, 'duplicate invariant ID in INVARIANTS.md');
});

test('INVARIANTS.md — the doc and the check registry hold the same ID set, both ways', () => {
  const docIds = entries.map((e) => e.id).sort();
  const registryIds = [...CHECKS.map((c) => c.id), ...Object.keys(TEST_ONLY)].sort();
  assert.deepEqual(
    docIds,
    registryIds,
    'INVARIANTS.md and src/commands/verify.ts disagree. Every documented invariant needs a check ' +
      '(or a TEST_ONLY entry naming its guard), and every registered check needs a documented block. ' +
      'IDs are append-only: retire, never rename or reuse.',
  );
});

test('INVARIANTS.md — the Check class matches where the ID is registered', () => {
  const byId = new Map(CHECKS.map((c) => [c.id, c]));
  for (const entry of entries) {
    if (entry.check === 'tests-only' || entry.check === 'human') {
      assert.ok(
        TEST_ONLY[entry.id],
        `${entry.id} is documented as ${entry.check} but is not in TEST_ONLY — it would render with no stated guard`,
      );
      assert.ok(!byId.has(entry.id), `${entry.id} is documented as ${entry.check} but has a runtime check`);
      continue;
    }
    const check = byId.get(entry.id);
    assert.ok(check, `${entry.id} is documented as '${entry.check}' but has no entry in CHECKS`);
    assert.equal(
      check.needs,
      entry.check,
      `${entry.id}: doc says '${entry.check}', the registry says '${check.needs}' — a run+pr check ` +
        'must skip under --offline, so the two cannot disagree',
    );
  }
});

test('INVARIANTS.md — every cited source and test path exists', () => {
  for (const entry of entries) {
    for (const path of [...entry.enforced, ...entry.verified]) {
      assert.ok(
        existsSync(join(REPO_ROOT, path)),
        `${entry.id} cites ${path}, which does not exist — a module moved or a test was renamed`,
      );
    }
  }
});

test('INVARIANTS.md — every entry names both where it is enforced and what verifies it', () => {
  for (const entry of entries) {
    assert.ok(entry.enforced.length > 0, `${entry.id} names no enforcing source file`);
    assert.ok(entry.verified.length > 0, `${entry.id} names no verifying test`);
  }
});

test('verify registry — TEST_ONLY entries state their guard, and no ID is registered twice', () => {
  const ids = [...CHECKS.map((c) => c.id), ...Object.keys(TEST_ONLY)];
  assert.deepEqual([...new Set(ids)], ids, 'an ID appears in both CHECKS and TEST_ONLY, or twice in one');
  for (const [id, reason] of Object.entries(TEST_ONLY)) {
    assert.match(reason, /guarded by|human judgment/i, `${id}'s TEST_ONLY reason must name its guard`);
  }
});
