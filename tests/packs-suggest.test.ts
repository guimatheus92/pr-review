import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { packsAdd, searchSkillsSh } from '../src/commands/packs.js';

const OBJECT_SHAPE = {
  query: 'code review',
  skills: [
    { id: '1', skillId: 'a', name: 'code-review', installs: 385249, source: 'mattpocock/skills/code-review' },
    { id: '2', skillId: 'b', name: 'requesting-code-review', installs: 206560, source: 'obra/superpowers/requesting-code-review' },
  ],
  count: 2,
};

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;
}

test('searchSkillsSh — parses the object shape and a bare array, ranked by installs', async () => {
  const fromObject = await searchSkillsSh('code review', fetchReturning(OBJECT_SHAPE));
  assert.deepEqual(fromObject.map((h) => h.name), ['code-review', 'requesting-code-review']);
  const fromArray = await searchSkillsSh('x', fetchReturning([{ name: 'a', installs: 1, source: 'o/r/a' }]));
  assert.equal(fromArray.length, 1);
});

test('searchSkillsSh — fail-soft: HTTP errors, rejects, and junk all yield []', async () => {
  assert.deepEqual(await searchSkillsSh('x', fetchReturning({}, false)), []);
  assert.deepEqual(
    await searchSkillsSh('x', (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch),
    [],
  );
  assert.deepEqual(await searchSkillsSh('x', fetchReturning('garbage')), []);
  assert.deepEqual(await searchSkillsSh('x', fetchReturning({ skills: [{ nope: 1 }] })), []);
});

test('packsAdd — absent skill_packs materializes the defaults first; append; duplicate is a no-op', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-padd-'));
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    const cfgPath = join(home, '.pr-review', 'config.yaml');

    // The "pack" is a local dir that is not a git repo → clone fails soft; the config edit is the point.
    const noClone = () => { throw new Error('offline test — no clone'); };
    const code = packsAdd('acme/some-pack', { home, git: noClone });
    assert.equal(code, 0);
    const cfg = parseYaml(readFileSync(cfgPath, 'utf8')) as { skill_packs: unknown[] };
    assert.ok(Array.isArray(cfg.skill_packs));
    // defaults materialized (REPLACE semantics would otherwise drop them) + the new entry
    assert.equal(cfg.skill_packs.length, 4, JSON.stringify(cfg.skill_packs));
    assert.ok(cfg.skill_packs.some((p) => (p as { name?: string }).name === 'awesome-copilot'));
    assert.equal(cfg.skill_packs[3], 'acme/some-pack');

    // duplicate → unchanged
    packsAdd('acme/some-pack', { home, git: () => { throw new Error('offline'); } });
    const cfg2 = parseYaml(readFileSync(cfgPath, 'utf8')) as { skill_packs: unknown[] };
    assert.equal(cfg2.skill_packs.length, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packsAdd — rejects a spec that is neither owner/repo, URL, nor an existing path', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-padd-'));
  try {
    assert.equal(packsAdd('definitely not a pack', { home }), 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('packsAdd — existing skill_packs list is appended to, not replaced', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-padd-'));
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    const cfgPath = join(home, '.pr-review', 'config.yaml');
    writeFileSync(cfgPath, 'skill_packs:\n  - octo/existing\n', 'utf8');
    packsAdd('acme/new-pack', { home, git: () => { throw new Error('offline'); } });
    const cfg = parseYaml(readFileSync(cfgPath, 'utf8')) as { skill_packs: unknown[] };
    assert.deepEqual(cfg.skill_packs, ['octo/existing', 'acme/new-pack']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
