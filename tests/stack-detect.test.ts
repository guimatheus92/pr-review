import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cwdMatchesPr, detectStack } from '../src/stack/detect.js';
import { parseLinguist } from '../src/stack/linguist.js';

test('cwdMatchesPr — GitHub/GitLab/ADO origin shapes, case-insensitive, .git optional', () => {
  assert.ok(cwdMatchesPr('https://github.com/Owner/Repo.git', 'owner', 'repo'));
  assert.ok(cwdMatchesPr('git@github.com:owner/repo.git', 'owner', 'repo'));
  assert.ok(cwdMatchesPr('https://dev.azure.com/org/proj/_git/repo', 'org', 'repo'));
  assert.ok(cwdMatchesPr('https://gitlab.com/group/sub/repo.git', 'group/sub', 'repo'));
  assert.ok(!cwdMatchesPr('https://github.com/owner/other-repo.git', 'owner', 'repo'));
  assert.ok(!cwdMatchesPr('https://github.com/someone-else/repo.git', 'owner', 'repo'));
  assert.ok(!cwdMatchesPr(null, 'owner', 'repo'));
});

const LINGUIST = parseLinguist(`
TypeScript:
  aliases: [ts]
  extensions: ['.ts']
HCL:
  aliases: [terraform]
  extensions: ['.tf']
`);

test('detectStack — language tags from changed paths + dependency tags from a matching checkout', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-stack-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    const info = detectStack([{ path: 'src/app.ts' }, { path: 'infra/main.tf' }], {
      linguist: LINGUIST,
      cwd,
      pr: { owner: 'octo', repo: 'app' },
      gitRemote: () => 'https://github.com/octo/app.git',
    });
    assert.deepEqual(info.languages, ['hcl', 'terraform', 'ts', 'typescript']);
    assert.deepEqual(info.dependencies, ['express']);
    assert.ok(info.tags.includes('express') && info.tags.includes('terraform') && info.tags.includes('node'));
    assert.deepEqual(info.notes, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('detectStack — cwd that is not the PR repo skips dependency tags with a note', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-stack-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    const info = detectStack([{ path: 'src/app.ts' }], {
      linguist: LINGUIST,
      cwd,
      pr: { owner: 'octo', repo: 'app' },
      gitRemote: () => 'https://github.com/octo/unrelated.git',
    });
    assert.deepEqual(info.dependencies, []);
    assert.ok(info.notes.some((n) => n.includes('manifests and skills are not used')));
    assert.ok(info.tags.includes('typescript'), 'language tags unaffected');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('detectStack — the PR’s own manifest diff contributes dependency tags (framework added IN the PR)', () => {
  const info = detectStack(
    [
      { path: 'package.json', patch: '@@ -1,3 +1,4 @@\n {\n+  "dependencies": { "svelte": "^4" },\n }' },
      { path: 'src/app.ts' },
    ],
    { linguist: LINGUIST },
  );
  assert.ok(info.dependencies.includes('svelte'), 'dep parsed from the + lines of the manifest patch');
  assert.ok(info.tags.includes('node'), 'manifest kind contributes ecosystem tags');
  assert.equal(info.cwdIsPrRepo, false);
});

test('maskUrl — credentials embedded in origin URLs never print', async () => {
  const { maskUrl } = await import('../src/stack/detect.js');
  assert.equal(maskUrl('https://user:tok3n@github.com/o/r.git'), 'https://***@github.com/o/r.git');
  assert.equal(maskUrl('https://github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(maskUrl(null), null);
});

test('detectStack — no Linguist: languages empty with a note, dependencies still work', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-stack-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { express: '4' } }));
    const info = detectStack([{ path: 'src/app.ts' }], {
      linguist: null,
      cwd,
      pr: { owner: 'octo', repo: 'app' },
      gitRemote: () => 'https://github.com/octo/app.git',
    });
    assert.deepEqual(info.languages, []);
    assert.ok(info.notes.some((n) => n.includes('language tags skipped')));
    assert.deepEqual(info.dependencies, ['express']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
