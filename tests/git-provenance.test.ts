import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitProvenance, newProvenanceCache } from '../src/util/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('gitProvenance — clean, modified, untracked and a staged rename are told apart (porcelain -z parsing)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pr-review-prov-'));
  try {
    for (const name of ['a.md', 'b.md', 'c.md', 'f.md']) writeFileSync(join(repo, name), `${name}\n`);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    appendFileSync(join(repo, 'b.md'), 'edit\n');
    writeFileSync(join(repo, 'd.md'), 'new\n');
    git(repo, 'mv', 'c.md', 'e.md'); // porcelain -z: `R  e.md\0c.md\0` — the old path is a separate token
    appendFileSync(join(repo, 'f.md'), 'edit\n'); // sorts after the rename; a mis-parsed rename would swallow it
    const cache = newProvenanceCache();
    assert.equal(gitProvenance(join(repo, 'a.md'), cache), 'clean');
    assert.equal(gitProvenance(join(repo, 'b.md'), cache), 'dirty');
    assert.equal(gitProvenance(join(repo, 'd.md'), cache), 'untracked');
    assert.equal(gitProvenance(join(repo, 'e.md'), cache), 'dirty', 'a staged rename is not clean');
    assert.equal(gitProvenance(join(repo, 'f.md'), cache), 'dirty', 'the entry after a rename is still parsed');
    assert.equal(cache.repos.size, 1, 'one repository → one status/ls-files pair');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('gitProvenance — a directory under no repository is no-repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-prov-none-'));
  try {
    writeFileSync(join(dir, 'x.md'), 'x\n');
    assert.equal(gitProvenance(join(dir, 'x.md'), newProvenanceCache()), 'no-repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitProvenance — a repository git cannot read is an error, never clean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-prov-broken-'));
  try {
    writeFileSync(join(dir, '.git'), 'gitdir: ' + join(dir, 'does-not-exist') + '\n');
    writeFileSync(join(dir, 'x.md'), 'x\n');
    assert.equal(gitProvenance(join(dir, 'x.md'), newProvenanceCache()), 'error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gitProvenance — a SKILL.md at the repository root owns the whole tree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pr-review-prov-root-'));
  try {
    writeFileSync(join(repo, 'SKILL.md'), '---\ndescription: root skill\n---\nBody.\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    assert.equal(gitProvenance(join(repo, 'SKILL.md'), newProvenanceCache(), repo), 'clean');
    mkdirSync(join(repo, 'references'));
    writeFileSync(join(repo, 'references', 'planted.md'), 'planted\n');
    assert.equal(gitProvenance(join(repo, 'SKILL.md'), newProvenanceCache(), repo), 'dirty');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
