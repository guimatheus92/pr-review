import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gatherFromPatch } from '../scripts/gather-from-patch.mjs';
import { applyDiffExclusions } from '../src/dispatch/diff-filter.js';
import { renderLockfileDigests } from '../src/dispatch/lockfile-digest.js';
import type { GatherOutput, LockfileDigest } from '../src/types.js';

const fixture = (name: string, file: string) =>
  readFileSync(fileURLToPath(new URL(`../evals/fixtures/${name}/${file}`, import.meta.url)), 'utf8');

test('gatherFromPatch — classifies added, modified, deleted, and renamed files', () => {
  const patch = [
    'diff --git a/src/old.ts b/src/old.ts',
    '--- a/src/old.ts',
    '+++ b/src/old.ts',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+one',
    '+two',
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    'deleted file mode 100644',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/src/before.ts b/src/after.ts',
    'similarity index 90%',
    'rename from src/before.ts',
    'rename to src/after.ts',
    '--- a/src/before.ts',
    '+++ b/src/after.ts',
    '@@ -1 +1 @@',
    '-before',
    '+after',
  ].join('\n');
  const gather = gatherFromPatch(patch);
  assert.deepEqual(
    gather.changedFiles.map((file) => ({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions })),
    [
      { path: 'src/old.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'src/new.ts', status: 'added', additions: 2, deletions: 0 },
      { path: 'src/deleted.ts', status: 'deleted', additions: 0, deletions: 1 },
      { path: 'src/after.ts', status: 'renamed', additions: 1, deletions: 1 },
    ],
  );
  assert.equal(gather.changedFiles[3].previousPath, 'src/before.ts');
  // #26: this is the last thing that ever produced a non-empty fullDiff, and it
  // feeds dogfood + the eval harness through --from-gather.
  assert.ok(!('fullDiff' in gather), 'the synthetic gather writes no fullDiff');
});

test('gatherFromPatch — parses Git C-quoted paths with spaces and octal escapes', () => {
  const patch = [
    'diff --git "a/src/foo\\040bar.ts" "b/src/foo\\040bar.ts"',
    '--- "a/src/foo bar.ts"',
    '+++ "b/src/foo bar.ts"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const gather = gatherFromPatch(patch);
  assert.equal(gather.changedFiles[0].path, 'src/foo bar.ts');
  assert.equal(gather.changedFiles[0].previousPath, undefined);
});

test('gatherFromPatch — rejects control characters decoded from quoted paths', () => {
  const patch = 'diff --git "a/safe\\012name.ts" "b/safe\\012name.ts"\n@@ -0,0 +1 @@\n+x';
  assert.throws(() => gatherFromPatch(patch), /control characters/);
});

test('gatherFromPatch — a lockfileDigests override passes through; absent by default', () => {
  const patch = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b';
  const digests = [{ path: 'package-lock.json', status: 'unavailable', reason: 'test' }];
  assert.deepEqual(gatherFromPatch(patch, { lockfileDigests: digests }).lockfileDigests, digests);
  assert.ok(!('lockfileDigests' in gatherFromPatch(patch)));
});

// Each pair moves ONE variable — the description, the digest, or the repository —
// so the diff the passes read must be the same bytes on both sides.
test('context eval pairs — the -safe control shares the positive case diff.patch byte for byte', () => {
  for (const name of ['pr-description-false-claim', 'lockfile-integrity', 'ts-unread-result-field']) {
    assert.equal(fixture(`${name}-safe`, 'diff.patch'), fixture(name, 'diff.patch'), name);
  }
});

// The digests are hand-written stand-ins for what gather computes. Rendering them
// through the real renderer, on the lockfile the fixture's own diff excludes, is
// what catches a shape drifted from LockfileDigest: a renamed field reads "undefined".
test('lockfile eval fixtures — each digest renders as the section gather would produce', () => {
  for (const name of ['lockfile-integrity', 'lockfile-integrity-safe']) {
    const digests = JSON.parse(fixture(name, 'lockfile-digests.json')) as LockfileDigest[];
    for (const change of digests.flatMap((d) => Object.values(d.changes ?? {}))) {
      assert.deepEqual(change.sample, [...change.sample].sort(), `${name}: samples are sorted, as digestPackageLock emits them`);
      assert.ok(change.sample.length <= Math.min(20, change.total), `${name}: sample within total and cap`);
    }
    const gather = gatherFromPatch(fixture(name, 'diff.patch'), { lockfileDigests: digests }) as GatherOutput;
    const rendered = renderLockfileDigests({ ...gather, changedFiles: applyDiffExclusions(gather.changedFiles) }).join('\n');
    assert.match(rendered, /## Lockfile Digest[\s\S]*- packages: 541 at base, 541 at head/, name);
    assert.match(rendered, /typescript 5\.7\.2 → 5\.7\.3/, name);
    assert.doesNotMatch(rendered, /undefined|digest unavailable|no package entry changed/, name);
    if (name.endsWith('-safe')) assert.doesNotMatch(rendered, /emnapi|resolved\/integrity/);
    else assert.match(rendered, /Lost resolved\/integrity: 419 \(first 20\)[\s\S]*@emnapi\/runtime dev: no → yes/);
  }
});