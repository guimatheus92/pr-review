import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillPack } from '../src/config.js';
import { listPackFiles, loadPackSkills } from '../src/packs/load.js';
import { packDir } from '../src/packs/sync.js';

function fakePack(home: string, name: string, files: Record<string, string>): SkillPack {
  const pack: SkillPack = { name, git: 'octo/x', include: ['instructions/*.instructions.md', 'skills/*/SKILL.md'], exclude: [], mode: 'auto', baseline: [] };
  const dir = packDir(pack, home);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return pack;
}

const FILES = {
  'README.md': '# readme (never a skill)',
  'docs/guide.md': '# docs (not included)',
  'instructions/go.instructions.md': "---\ndescription: Go rules\napplyTo: '**/*.go'\n---\n# Go\n",
  'skills/a/SKILL.md': '---\nname: a\ndescription: skill a\n---\nbody a\n',
  'skills/hunting-foo/SKILL.md': '---\nname: hunting-foo\ndescription: ops\n---\nops body\n',
};

test('listPackFiles — include picks skills, never READMEs/docs; exclude works by skill name', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-pload-'));
  try {
    const pack = fakePack(home, 'p1', FILES);
    const all = listPackFiles(packDir(pack, home), pack.include, pack.exclude);
    assert.deepEqual(all, ['instructions/go.instructions.md', 'skills/a/SKILL.md', 'skills/hunting-foo/SKILL.md']);
    const excluded = listPackFiles(packDir(pack, home), pack.include, ['hunting-*']);
    assert.deepEqual(excluded, ['instructions/go.instructions.md', 'skills/a/SKILL.md']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadPackSkills — pack-prefixed names, origin/mode set, missing checkout contributes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-pload-'));
  try {
    const pack = fakePack(home, 'p1', FILES);
    pack.exclude = ['hunting-*'];
    const missing: SkillPack = { name: 'ghost', git: 'octo/ghost', include: ['**/SKILL.md'], exclude: [], mode: 'index', baseline: [] };
    const skills = loadPackSkills([pack, missing], home);
    assert.deepEqual(skills.map((s) => s.name).sort(), ['p1/a', 'p1/go']);
    for (const s of skills) {
      assert.equal(s.pack, 'p1');
      assert.equal(s.origin, 'pack');
      assert.equal(s.mode, 'auto');
    }
    const go = skills.find((s) => s.name === 'p1/go')!;
    assert.deepEqual(go.appliesTo, ['**/*.go']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadPackSkills — index mode is stamped on every skill of the pack', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-pload-'));
  try {
    const pack = fakePack(home, 'pidx', { 'skills/a/SKILL.md': FILES['skills/a/SKILL.md'] });
    pack.mode = 'index';
    const skills = loadPackSkills([pack], home);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.mode, 'index');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadPackSkills — same normalized name twice in one pack: later file wins with a warning', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-pload-'));
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    const pack = fakePack(home, 'pdup', {
      'instructions/csharp.instructions.md': '---\ndescription: from instructions\n---\ninstructions body\n',
      'skills/csharp/SKILL.md': '---\nname: csharp\ndescription: from skills\n---\nskills body\n',
    });
    const skills = loadPackSkills([pack], home);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, 'pdup/csharp');
    assert.match(skills[0]!.body, /skills body/, 'later (sorted) file wins');
    assert.ok(lines.some((l) => l.includes("duplicate skill name 'pdup/csharp'")));
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
    rmSync(home, { recursive: true, force: true });
  }
});
