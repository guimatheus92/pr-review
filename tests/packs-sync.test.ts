import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillPack } from '../src/config.js';
import {
  STALE_DAYS,
  ensurePacks,
  gitAvailable,
  gitUrl,
  packDir,
  packMetaPath,
  packStatus,
  syncPacks,
} from '../src/packs/sync.js';

const HAVE_GIT = gitAvailable();
const skip = HAVE_GIT ? false : 'git not on PATH';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

/** A plain local work repo serves as the "remote": clone and ff-pull both work offline. */
function makeRemote(root: string): string {
  const remote = join(root, 'remote-pack');
  mkdirSync(join(remote, 'skills', 'a'), { recursive: true });
  writeFileSync(join(remote, 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: skill a\n---\nbody a\n');
  writeFileSync(join(remote, 'README.md'), '# remote pack\n');
  git(['init', '-b', 'main'], remote);
  git(['add', '.'], remote);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--no-verify', '-q', '-m', 'init'], remote);
  return remote;
}

function pack(remote: string, name = 'test-pack'): SkillPack {
  return { name, git: remote, include: ['**/SKILL.md'], exclude: [], mode: 'auto', baseline: [] };
}

test('gitUrl — owner/repo shorthand becomes a GitHub https URL; everything else passes through', () => {
  assert.equal(gitUrl({ git: 'github/awesome-copilot' }), 'https://github.com/github/awesome-copilot.git');
  assert.equal(gitUrl({ git: 'https://gitlab.com/a/b.git' }), 'https://gitlab.com/a/b.git');
  assert.equal(gitUrl({ git: 'C:/some/local/path' }), 'C:/some/local/path');
});

test('ensurePacks — clones a missing pack, writes meta, and does not re-clone next time', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-packs-'));
  const home = join(root, 'home');
  try {
    const remote = makeRemote(root);
    const p = pack(remote);

    const first = ensurePacks([p], { home });
    assert.deepEqual(first.cloned, ['test-pack']);
    assert.equal(first.present.length, 1);
    assert.ok(existsSync(join(packDir(p, home), 'skills', 'a', 'SKILL.md')));
    const meta = JSON.parse(readFileSync(packMetaPath(p, home), 'utf8'));
    assert.ok(meta.syncedAt);
    assert.ok(meta.commit);

    // Present + fresh: a git exec that throws proves no git call is made.
    const boom = () => {
      throw new Error('git must not run for a present, fresh pack');
    };
    const second = ensurePacks([p], { home, git: boom });
    assert.deepEqual(second.cloned, []);
    assert.equal(second.present.length, 1);
    assert.deepEqual(second.warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('syncPacks — pull picks up a new upstream commit and refreshes meta', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-packs-'));
  const home = join(root, 'home');
  try {
    const remote = makeRemote(root);
    const p = pack(remote);
    ensurePacks([p], { home });
    const before = JSON.parse(readFileSync(packMetaPath(p, home), 'utf8'));

    writeFileSync(join(remote, 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: updated\n---\nnew body\n');
    git(['add', '.'], remote);
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--no-verify', '-q', '-m', 'update'], remote);

    const result = syncPacks([p], { home });
    assert.equal(result.failed.length, 0, JSON.stringify(result.failed));
    assert.equal(result.synced.length, 1);
    const body = readFileSync(join(packDir(p, home), 'skills', 'a', 'SKILL.md'), 'utf8');
    assert.match(body, /new body/);
    const after = JSON.parse(readFileSync(packMetaPath(p, home), 'utf8'));
    assert.notEqual(after.commit, before.commit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensurePacks — a dir that is not a git checkout is skipped with a warning, never deleted', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-packs-'));
  const home = join(root, 'home');
  try {
    const p: SkillPack = { name: 'not-git', git: 'octo/x', include: ['**/SKILL.md'], exclude: [], mode: 'auto', baseline: [] };
    mkdirSync(packDir(p, home), { recursive: true });
    writeFileSync(join(packDir(p, home), 'user-data.txt'), 'precious');
    const res = ensurePacks([p], { home });
    assert.equal(res.present.length, 0);
    assert.ok(res.warnings.some((w) => w.includes('not a git checkout')));
    assert.ok(existsSync(join(packDir(p, home), 'user-data.txt')), 'user data untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensurePacks — a bad source warns and leaves no directory behind', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-packs-'));
  const home = join(root, 'home');
  try {
    const p: SkillPack = {
      name: 'broken',
      git: join(root, 'does-not-exist'),
      include: ['**/SKILL.md'],
      exclude: [],
      mode: 'auto',
      baseline: [],
    };
    const res = ensurePacks([p], { home });
    assert.equal(res.present.length, 0);
    assert.ok(res.warnings.some((w) => w.includes('clone failed')));
    assert.ok(!existsSync(packDir(p, home)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensurePacks — stale meta (or none) on a present pack warns to run packs sync', { skip }, () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-packs-'));
  const home = join(root, 'home');
  try {
    const remote = makeRemote(root);
    const p = pack(remote);
    ensurePacks([p], { home });

    const old = new Date(Date.now() - (STALE_DAYS + 10) * 86_400_000).toISOString();
    writeFileSync(packMetaPath(p, home), JSON.stringify({ git: p.git, syncedAt: old }), 'utf8');
    const st = packStatus(p, home);
    assert.ok(st.ageDays !== null && st.ageDays > STALE_DAYS);
    const res = ensurePacks([p], { home, git: () => '' });
    assert.equal(res.present.length, 1, 'stale is a warning, not a removal');
    assert.ok(res.warnings.some((w) => w.includes('packs sync')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
