import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import {
  GitLabProvider,
  classifyAuthor,
  isTransientGitLabError,
  mapDiff,
  buildFullDiff,
  positionForLine,
} from '../../src/providers/gitlab.js';
import { detectProvider } from '../../src/providers/index.js';
import { gatherCachePath, safeOwner, CACHE_ROOT } from '../../src/cache/keys.js';
import { ensureRunDir } from '../../src/util/tmp.js';
import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

test('GitLabProvider.parseUrl — accepted shapes, nested namespaces keep slashes', () => {
  const p = new GitLabProvider();
  const simple = p.parseUrl('https://gitlab.com/group/proj/-/merge_requests/42');
  assert.deepEqual(
    { ...simple },
    {
      provider: 'gitlab',
      url: 'https://gitlab.com/group/proj/-/merge_requests/42',
      owner: 'group',
      repo: 'proj',
      number: 42,
      baseUrl: 'https://gitlab.com/api/v4',
    },
  );
  // Nested subgroups: owner is the full namespace path.
  const nested = p.parseUrl('https://gitlab.com/group/sub/deep/proj/-/merge_requests/7');
  assert.equal(nested?.owner, 'group/sub/deep');
  assert.equal(nested?.repo, 'proj');
  // Legacy form without /-/.
  assert.equal(p.parseUrl('https://gitlab.com/group/proj/merge_requests/9')?.number, 9);
  // Trailing junk.
  assert.equal(p.parseUrl('https://gitlab.com/g/p/-/merge_requests/3/diffs?tab=x#note_5')?.number, 3);
  // Self-managed host → baseUrl follows the origin.
  assert.equal(
    p.parseUrl('https://gitlab.mycorp.com/team/app/-/merge_requests/1')?.baseUrl,
    'https://gitlab.mycorp.com/api/v4',
  );
});

test('GitLabProvider.parseUrl — rejects non-MR URLs and bare projects', () => {
  const p = new GitLabProvider();
  assert.equal(p.parseUrl('https://gitlab.com/group/proj/-/issues/42'), null);
  assert.equal(p.parseUrl('https://gitlab.com/proj/-/merge_requests/42'), null); // no namespace
  assert.equal(p.parseUrl('https://gitlab.com/group/proj/-/merge_requests/abc'), null);
  assert.equal(p.parseUrl('not a url'), null);
});

test('detectProvider — gitlab.com hostname and /-/merge_requests heuristic on self-managed hosts', () => {
  assert.equal(detectProvider('https://gitlab.com/g/p/-/merge_requests/1', {}).name, 'gitlab');
  assert.equal(detectProvider('https://git.mycorp.com/team/app/-/merge_requests/5', {}).name, 'gitlab');
  // Legacy no-/-/ form on an unknown host is too weak a signal → hosts: map required.
  assert.equal(detectProvider('https://git.mycorp.com/team/app/merge_requests/5', { 'git.mycorp.com': 'gitlab' }).name, 'gitlab');
});

test('mapDiff — status flags, rename previousPath, +/- counts, empty diff', () => {
  const base = { old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: false, renamed_file: false };
  const patch = '@@ -1,3 +1,4 @@\n context\n-gone\n+added one\n+added two\n context';
  const modified = mapDiff({ ...base, diff: patch });
  assert.equal(modified.status, 'modified');
  assert.equal(modified.additions, 2);
  assert.equal(modified.deletions, 1);
  assert.equal(modified.patch, patch);
  assert.equal(mapDiff({ ...base, new_file: true, diff: '' }).status, 'added');
  assert.equal(mapDiff({ ...base, deleted_file: true, diff: '' }).status, 'deleted');
  const renamed = mapDiff({ ...base, old_path: 'old.ts', new_path: 'new.ts', renamed_file: true, diff: '' });
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.previousPath, 'old.ts');
  assert.equal(renamed.patch, undefined, 'empty diff maps to no patch');
});

test('buildFullDiff — git-style headers, /dev/null for adds and deletes', () => {
  const out = buildFullDiff([
    { old_path: 'a.ts', new_path: 'a.ts', new_file: true, deleted_file: false, renamed_file: false, diff: '@@ -0,0 +1 @@\n+x' },
    { old_path: 'b.ts', new_path: 'b.ts', new_file: false, deleted_file: true, renamed_file: false, diff: '@@ -1 +0,0 @@\n-y' },
  ]);
  assert.ok(out.includes('diff --git a/a.ts b/a.ts\n--- /dev/null\n+++ b/a.ts'));
  assert.ok(out.includes('diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ /dev/null'));
});

// The position math that keeps GitLab from rejecting discussions with
// 400 "position is invalid": added lines carry new_line only, context lines
// must also carry the matching old_line.
test('positionForLine — added line has no oldLine, context line has the offset-corrected oldLine', () => {
  // old: 1 ctx / 2 gone / 3 ctx      new: 1 ctx / 2 added / 3 ctx / 4 added2
  const patch = '@@ -1,3 +1,4 @@\n ctx\n-gone\n+added\n ctx\n+added2';
  assert.deepEqual(positionForLine(patch, 2), { newLine: 2 }, 'added line: new_line only');
  assert.deepEqual(positionForLine(patch, 3), { newLine: 3, oldLine: 3 }, 'context line after a -/+ pair keeps both cursors');
  assert.deepEqual(positionForLine(patch, 4), { newLine: 4 }, 'trailing added line');
  assert.equal(positionForLine(patch, 99), null, 'line not in the patch');
});

test('positionForLine — multi-hunk cursors reset per @@ header', () => {
  const patch = '@@ -1,2 +1,2 @@\n ctx\n ctx\n@@ -10,3 +20,4 @@\n ctx\n+new\n ctx\n ctx';
  assert.deepEqual(positionForLine(patch, 20), { newLine: 20, oldLine: 10 });
  assert.deepEqual(positionForLine(patch, 21), { newLine: 21 });
  assert.deepEqual(positionForLine(patch, 22), { newLine: 22, oldLine: 11 });
});

test('classifyAuthor — GitLab bot account patterns', () => {
  assert.equal(classifyAuthor('project_42_bot_a1b2'), 'bot');
  assert.equal(classifyAuthor('group_7_bot'), 'bot');
  assert.equal(classifyAuthor('renovate-bot'), 'bot');
  assert.equal(classifyAuthor('ghost'), 'bot');
  assert.equal(classifyAuthor('copilot-reviewer'), 'copilot');
  assert.equal(classifyAuthor('tifftruong'), 'human');
  assert.equal(classifyAuthor('botanica'), 'human', 'bot must be a word segment, not a prefix of a name');
});

test('isTransientGitLabError — 429/5xx retry, 4xx not', () => {
  const err = (status?: number) => Object.assign(new Error('x'), { status });
  assert.equal(isTransientGitLabError(err(429)), true);
  assert.equal(isTransientGitLabError(err(500)), true);
  assert.equal(isTransientGitLabError(err(503)), true);
  assert.equal(isTransientGitLabError(err(400)), false);
  assert.equal(isTransientGitLabError(err(404)), false);
  assert.equal(isTransientGitLabError(err(undefined)), false);
});

// The slashed-owner bug: without flattening, a nested namespace would mint a
// NESTED run dir, and `status <run-id>` (which resolves basename(outDir))
// would look in the wrong place — every detached GitLab run reads as missing.
test('safeOwner — slashed namespaces flatten in run dirs and cache paths; github/ado unchanged', () => {
  const ref = new GitLabProvider().parseUrl('https://gitlab.com/group/sub/proj/-/merge_requests/5')!;
  assert.equal(safeOwner(ref), 'group-sub');
  assert.equal(
    gatherCachePath(ref, 'abcdef123456deadbeef', 'none'),
    join(CACHE_ROOT, 'gitlab', 'group-sub__proj', '5', 'abcdef123456-none.json'),
  );
  const outDir = ensureRunDir(ref);
  try {
    const id = basename(outDir);
    assert.ok(id.startsWith('gitlab__group-sub__proj__5__'), `flat run id, got ${id}`);
    assert.equal(basename(dirname(outDir)), 'runs', 'run dir sits directly under runs/ (not nested)');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  assert.equal(safeOwner({ owner: 'octo' }), 'octo', 'github/ado owners pass through untouched');
});
