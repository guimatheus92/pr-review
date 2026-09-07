import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDogfoodExclusions,
  collectBranchDiff,
  ensureBundleFresh,
  githubRepoFromRemote,
  newFilePatch,
  parseDogfoodArgs,
  safeDiagnosticValue,
  sensitiveTrackedPatch,
} from '../scripts/dogfood.mjs';
import { gatherFromPatch } from '../scripts/gather-from-patch.mjs';
import { buildBundle } from '../scripts/bundle.mjs';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createBundleFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-bundle-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"0.0.0"}');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'scripts', 'bundle.mjs'), '');
  writeFileSync(join(root, 'src', 'cli.ts'), 'export {};');
  return root;
}

test('safeDiagnosticValue — harness errors cannot inject or overwrite log lines', () => {
  const rendered = safeDiagnosticValue('bad --base\rforged\nnext\u0007');
  assert.equal(rendered, '"bad --base\\rforged\\nnext\\u0007"');
  assert.equal(rendered.split(/\r?\n/).length, 1);
});

test('parseDogfoodArgs — preserves forwarded flags when --base is omitted', () => {
  assert.deepEqual(parseDogfoodArgs(['--context-only', '--no-codex']), {
    help: false,
    baseRef: 'origin/main',
    includeUntracked: false,
    extra: ['--context-only', '--no-codex'],
  });
  assert.deepEqual(parseDogfoodArgs(['--base', 'upstream/main', '--include-untracked', '--context-only']), {
    help: false,
    baseRef: 'upstream/main',
    includeUntracked: true,
    extra: ['--context-only'],
  });
  assert.equal(parseDogfoodArgs(['--help']).help, true);
  for (const forbidden of ['--detach', '--resume', '--run-dir=x', '--from-gather=x', '--force-post']) {
    assert.throws(() => parseDogfoodArgs([forbidden]), /controlled by dogfood/);
  }
});

test('githubRepoFromRemote — derives fork identity from HTTPS and SSH remotes', () => {
  assert.deepEqual(githubRepoFromRemote('https://github.com/octo/example.git'), {
    provider: 'github', owner: 'octo', repo: 'example', number: 1,
    url: 'https://github.com/octo/example/pull/1',
  });
  assert.equal(githubRepoFromRemote('git@github.com:fork-owner/example.git').owner, 'fork-owner');
  assert.throws(() => githubRepoFromRemote('https://dev.azure.com/org/project/_git/repo'), /github\.com origins only/);
});

test('collectBranchDiff — rejects the default branch', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-'));
  try {
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['config', 'user.email', 'dogfood@example.test']);
    git(cwd, ['config', 'user.name', 'Dogfood Test']);
    writeFileSync(join(cwd, 'tracked.txt'), 'base\n');
    git(cwd, ['add', 'tracked.txt']);
    git(cwd, ['commit', '-m', 'base']);
    assert.throws(() => collectBranchDiff('main', cwd), /feature branch/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('collectBranchDiff — gathers committed, staged, unstaged, and opted-in untracked files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-'));
  try {
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['config', 'user.email', 'dogfood@example.test']);
    git(cwd, ['config', 'user.name', 'Dogfood Test']);
    writeFileSync(join(cwd, 'tracked.txt'), 'base\n');
    git(cwd, ['add', 'tracked.txt']);
    git(cwd, ['commit', '-m', 'base']);
    git(cwd, ['checkout', '-b', 'feature']);
    writeFileSync(join(cwd, 'committed.txt'), 'committed feature change\n');
    git(cwd, ['add', 'committed.txt']);
    git(cwd, ['commit', '-m', 'feature change']);
    writeFileSync(join(cwd, 'staged.txt'), 'staged change\n');
    git(cwd, ['add', 'staged.txt']);
    writeFileSync(join(cwd, 'tracked.txt'), 'changed\n');
    mkdirSync(join(cwd, 'new'), { recursive: true });
    writeFileSync(join(cwd, 'new', 'untracked.txt'), 'untracked\n');
    const trackedOnly = gatherFromPatch(collectBranchDiff('main', cwd).patchText);
    assert.deepEqual(
      trackedOnly.changedFiles.map((file) => file.path).sort(),
      ['committed.txt', 'staged.txt', 'tracked.txt'],
      'committed, staged, and unstaged tracked changes are all included',
    );
    const diff = collectBranchDiff('main', cwd, true);
    const gather = gatherFromPatch(diff.patchText);
    assert.deepEqual(
      gather.changedFiles.map((file) => `${file.path}:${file.status}`).sort(),
      ['committed.txt:added', 'new/untracked.txt:added', 'staged.txt:added', 'tracked.txt:modified'],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('applyDogfoodExclusions — excludes metadata binaries without matching the phrase inside text hunks', () => {
  const gather = {
    changedFiles: [
      { path: 'src/cli.ts' },
      { path: 'dist/cli.cjs' },
      { path: 'asset.bin', patch: 'Binary files /dev/null and b/asset.bin differ' },
      { path: 'src/example.ts', patch: '@@ -1 +1 @@\n+const marker = "Binary files /dev/null and b/x differ";' },
    ],
  };
  applyDogfoodExclusions(gather);
  assert.equal(gather.changedFiles[0].excluded, undefined);
  assert.equal(gather.changedFiles[1].excluded, true);
  assert.match(gather.changedFiles[1].excludedReason, /generated bundle/);
  assert.equal(gather.changedFiles[2].excluded, true);
  assert.match(gather.changedFiles[2].excludedReason, /binary file/);
  assert.equal(gather.changedFiles[3].excluded, undefined);
});

test('sensitiveTrackedPatch — generated bundle is skipped but equivalent source remains blocked', () => {
  const token = 'P'.repeat(52);
  const patch = (path: string) => [
    `diff --git a/${path} b/${path}`,
    '--- a/' + path,
    '+++ b/' + path,
    '@@ -0,0 +1 @@',
    `+azureDevOpsPat = ${token}`,
  ].join('\n');
  assert.equal(sensitiveTrackedPatch(patch('dist/cli.cjs')), null);
  assert.deepEqual(sensitiveTrackedPatch(patch('src/config.ts')), {
    path: 'src/config.ts',
    reason: 'legacy Azure DevOps PAT',
  });
});

test('sensitiveTrackedPatch — a values-free template is reviewable, the same name with a value is not', () => {
  // Regression: adding `.env.example` made this refuse the whole branch diff on
  // the NAME alone, so dogfood — a required pre-PR step — could not run at all
  // on the branch that introduced it. The carve-out is for the name check only,
  // which is why the second half of this test must still be refused.
  const patch = (path: string, line: string) =>
    [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -0,0 +1 @@', `+${line}`].join('\n');

  for (const path of ['.env.example', '.env.sample', 'config.template.yaml', 'secrets.sample.json']) {
    assert.equal(sensitiveTrackedPatch(patch(path, 'GITHUB_TOKEN=')), null, `${path} without a value must be reviewable`);
  }

  // A real token inside a template is still a real token.
  assert.deepEqual(sensitiveTrackedPatch(patch('.env.example', `GITHUB_TOKEN=ghp_${'A'.repeat(36)}`)), {
    path: '.env.example',
    reason: 'GitHub token',
  });

  // And the names the carve-out must not reach.
  for (const path of ['.env', '.env.local', 'id_rsa', 'secrets/credentials.json']) {
    assert.deepEqual(
      sensitiveTrackedPatch(patch(path, 'nothing=here')),
      { path, reason: 'secret-bearing path' },
      `${path} must still be refused on its name`,
    );
  }
});

test('sensitiveTrackedPatch — a multi-line literal opener is not a value, its contents still are', () => {
  // Regression: `const CREDENTIAL_FILES = [` matched the sensitive-key heuristic
  // on its NAME and then counted the bare `[` as a material value, refusing the
  // whole branch diff. The declaration continues on the next line; the opener
  // carries nothing.
  const patch = (lines: string[]) =>
    ['diff --git a/scripts/x.mjs b/scripts/x.mjs', '--- a/scripts/x.mjs', '+++ b/scripts/x.mjs', `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n');

  assert.equal(sensitiveTrackedPatch(patch(['const CREDENTIAL_FILES = [', "  join(root, '.env'),", '];'])), null);
  assert.equal(sensitiveTrackedPatch(patch(['const apiKey = {', '  from: process.env.KEY,', '};'])), null);

  // A real token on a continuation line is still caught.
  assert.deepEqual(sensitiveTrackedPatch(patch(['const CREDENTIAL_FILES = [', `  'ghp_${'B'.repeat(36)}',`, '];'])), {
    path: 'scripts/x.mjs',
    reason: 'GitHub token',
  });
  // And a real value on the declaration line itself is unaffected.
  assert.deepEqual(sensitiveTrackedPatch(patch(['const clientSecret = "s3cr3t-value-not-a-placeholder";'])), {
    path: 'scripts/x.mjs',
    reason: 'sensitive setting clientSecret',
  });
});

test('sensitiveTrackedPatch — checks both sides of a rename before bundle exclusion', () => {
  const renamePatch = (previousPath: string, path: string, quoted = false) => {
    const header = quoted
      ? `diff --git "a/${previousPath}" "b/${path.replaceAll(' ', '\\040')}"`
      : `diff --git a/${previousPath} b/${path}`;
    return [
      header,
      'similarity index 100%',
      `rename from ${previousPath}`,
      `rename to ${path}`,
    ].join('\n');
  };
  const cases = [
    { previousPath: '.env.local', path: 'config.example', blockedPath: '.env.local' },
    { previousPath: 'config.ts', path: 'id_rsa', blockedPath: 'id_rsa' },
    { previousPath: 'src/old.ts', path: 'src/new.ts' },
    { previousPath: '.env.local', path: 'dist/cli.cjs', blockedPath: '.env.local' },
    { previousPath: 'secrets/credentials.json', path: 'safe config.ts', blockedPath: 'secrets/credentials.json', quoted: true },
  ];
  for (const scenario of cases) {
    const result = sensitiveTrackedPatch(renamePatch(scenario.previousPath, scenario.path, scenario.quoted));
    if (scenario.blockedPath) {
      assert.deepEqual(result, { path: scenario.blockedPath, reason: 'secret-bearing path' }, JSON.stringify(scenario));
    } else {
      assert.equal(result, null, JSON.stringify(scenario));
    }
  }
});

test('collectBranchDiff — rejects a real Git rename from a sensitive path while allowing benign renames', () => {
  const run = (previousPath: string, path: string) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-rename-'));
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['config', 'user.email', 'dogfood@example.test']);
    git(cwd, ['config', 'user.name', 'Dogfood Test']);
    writeFileSync(join(cwd, previousPath), 'fixture\n');
    git(cwd, ['add', previousPath]);
    git(cwd, ['commit', '-m', 'base']);
    git(cwd, ['checkout', '-b', 'feature']);
    git(cwd, ['mv', previousPath, path]);
    return { cwd, collect: () => collectBranchDiff('main', cwd) };
  };

  const sensitive = run('.env.local', 'config.example');
  const benign = run('old-config.ts', 'new-config.ts');
  try {
    assert.throws(sensitive.collect, /secret-bearing tracked diff \(secret-bearing path; path redacted\)/);
    const gather = gatherFromPatch(benign.collect().patchText);
    assert.deepEqual(gather.changedFiles.map(({ previousPath, path, status }) => ({ previousPath, path, status })), [
      { previousPath: 'old-config.ts', path: 'new-config.ts', status: 'renamed' },
    ]);
  } finally {
    rmSync(sensitive.cwd, { recursive: true, force: true });
    rmSync(benign.cwd, { recursive: true, force: true });
  }
});

test('ensureBundleFresh — rejects a missing bundle', () => {
  const root = createBundleFixture();
  try {
    assert.throws(() => ensureBundleFresh(root), /missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureBundleFresh — rejects a newer but byte-mismatched bundle', () => {
  const root = createBundleFixture();
  try {
    const bundle = join(root, 'dist', 'cli.cjs');
    writeFileSync(bundle, 'not the canonical bundle');
    assert.throws(() => ensureBundleFresh(root), /does not match the current source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureBundleFresh — accepts the canonical current-source bundle', () => {
  const root = createBundleFixture();
  try {
    const bundle = join(root, 'dist', 'cli.cjs');
    buildBundle(root, bundle, 'silent');
    assert.doesNotThrow(() => ensureBundleFresh(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — refuses a file reached through an external directory link', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-outside-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'outside\n');
    try {
      symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        context.skip(`directory links unavailable: ${code}`);
        return;
      }
      throw error;
    }
    assert.throws(() => newFilePatch(root, 'linked/secret.txt'), /outside the repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('newFilePatch — an empty untracked file has zero added lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-empty-'));
  try {
    writeFileSync(join(root, 'empty.txt'), '');
    const patch = newFilePatch(root, 'empty.txt');
    const gather = gatherFromPatch(patch);
    assert.equal(gather.changedFiles[0].status, 'added');
    assert.equal(gather.changedFiles[0].additions, 0);
    assert.equal(gather.changedFiles[0].deletions, 0);
    assert.ok(!patch.includes('@@'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const secretPath of ['.env.local', 'github_token.txt', 'prod-secrets.json', 'passwords.txt', 'id_rsa', '.npmrc']) {
  test(`collectBranchDiff — refuses untracked ${secretPath} even with opt-in`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-secret-'));
    try {
      git(cwd, ['init', '-b', 'main']);
      git(cwd, ['config', 'user.email', 'dogfood@example.test']);
      git(cwd, ['config', 'user.name', 'Dogfood Test']);
      writeFileSync(join(cwd, 'tracked.txt'), 'base\n');
      git(cwd, ['add', 'tracked.txt']);
      git(cwd, ['commit', '-m', 'base']);
      git(cwd, ['checkout', '-b', 'feature']);
      writeFileSync(join(cwd, secretPath), 'SECRET=value\n');
      assert.throws(
        () => collectBranchDiff('main', cwd, true),
        (error: unknown) => {
          const message = (error as Error).message;
          assert.match(message, /secret-bearing/);
          assert.ok(!message.includes(secretPath), 'secret-bearing path is redacted from diagnostics');
          return true;
        },
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

for (const [configPath, contents] of [
  ['local.settings.json', JSON.stringify({ Values: { AZURE_CLIENT_SECRET: 'live-local-value' } })],
  [
    'appsettings.Development.json',
    JSON.stringify({ ConnectionStrings: { Main: ['Server=db', 'User Id=app', ['Pass', 'word=live-value'].join('')].join(';') } }),
  ],
  ['config.json', JSON.stringify({ apiKey: 'live-config-value' })],
] as const) {
  test(`newFilePatch — refuses sensitive content in ${configPath}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-content-secret-'));
    try {
      writeFileSync(join(root, configPath), contents);
      assert.throws(() => newFilePatch(root, configPath), /secret-bearing untracked content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('newFilePatch — refuses a private key signature even in a generically named text file', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-private-key-'));
  try {
    const pemFixture = ['-----BEGIN ', 'PRIVATE', ' KEY-----\nmaterial\n-----END ', 'PRIVATE', ' KEY-----'].join('');
    writeFileSync(join(root, 'notes.txt'), pemFixture);
    assert.throws(() => newFilePatch(root, 'notes.txt'), /secret-bearing untracked content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — scans high-confidence secrets before unsupported extensions become binary patches', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-unsupported-secret-'));
  try {
    const token = ['gh', 'p_', 'A'.repeat(24)].join('');
    writeFileSync(join(root, 'token.dat'), token);
    assert.throws(() => newFilePatch(root, 'token.dat'), /secret-bearing untracked content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const direction of ['added', 'removed'] as const) {
  test(`collectBranchDiff — refuses a high-confidence secret ${direction} in a tracked hunk`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-tracked-secret-'));
    try {
      const token = ['gh', 'p_', 'B'.repeat(24)].join('');
      git(cwd, ['init', '-b', 'main']);
      git(cwd, ['config', 'user.email', 'dogfood@example.test']);
      git(cwd, ['config', 'user.name', 'Dogfood Test']);
      writeFileSync(join(cwd, 'config.txt'), direction === 'removed' ? `${token}\n` : 'safe\n');
      git(cwd, ['add', 'config.txt']);
      git(cwd, ['commit', '-m', 'base']);
      git(cwd, ['checkout', '-b', 'feature']);
      writeFileSync(join(cwd, 'config.txt'), direction === 'added' ? `${token}\n` : 'safe\n');
      assert.throws(() => collectBranchDiff('main', cwd), /secret-bearing tracked diff/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('collectBranchDiff — refuses a high-confidence secret in persisted context lines', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-context-secret-'));
  try {
    const token = ['gh', 'p_', 'C'.repeat(24)].join('');
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['config', 'user.email', 'dogfood@example.test']);
    git(cwd, ['config', 'user.name', 'Dogfood Test']);
    writeFileSync(join(cwd, 'config.txt'), `${token}\nunchanged\nbefore\n`);
    git(cwd, ['add', 'config.txt']);
    git(cwd, ['commit', '-m', 'base']);
    git(cwd, ['checkout', '-b', 'feature']);
    writeFileSync(join(cwd, 'config.txt'), `${token}\nunchanged\nafter\n`);
    assert.throws(() => collectBranchDiff('main', cwd), /secret-bearing tracked diff/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('newFilePatch — permits ordinary JSON configuration with placeholders', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-benign-config-'));
  try {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ apiKey: '${API_KEY}', featureEnabled: true }));
    assert.match(newFilePatch(root, 'config.json'), /featureEnabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — non-UTF8 content is recorded as binary even with a text extension', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-encoding-'));
  try {
    writeFileSync(join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0xfd]));
    const patch = newFilePatch(root, 'invalid.txt');
    assert.match(patch, /^Binary files .* differ$/m);
    assert.ok(!patch.includes('@@'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — treats UTF-8 .patch fixtures as reviewable text', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-patch-'));
  try {
    writeFileSync(join(root, 'diff.patch'), 'diff --git a/a.ts b/a.ts\n+review me\n');
    const patch = newFilePatch(root, 'diff.patch');
    assert.match(patch, /^@@ -0,0 /m);
    assert.match(patch, /^\+diff --git a\/a\.ts b\/a\.ts$/m);
    assert.doesNotMatch(patch, /Binary files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — rejects control characters in paths before reading files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-control-path-'));
  try {
    assert.throws(() => newFilePatch(root, 'safe.txt\n@@ -0,0 +1 @@\n+injected'), /control characters/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — refuses a declared apiKey in untracked source text', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-source-secret-'));
  try {
    const declaration = ['const api', 'Key = "material-value-123";\n'].join('');
    writeFileSync(join(root, 'source.ts'), declaration);
    assert.throws(() => newFilePatch(root, 'source.ts'), /secret-bearing untracked content/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('collectBranchDiff — refuses a declared clientSecret in tracked source text', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-tracked-source-secret-'));
  try {
    git(cwd, ['init', '-b', 'main']);
    git(cwd, ['config', 'user.email', 'dogfood@example.test']);
    git(cwd, ['config', 'user.name', 'Dogfood Test']);
    writeFileSync(join(cwd, 'source.ts'), 'export const enabled = true;\n');
    git(cwd, ['add', 'source.ts']);
    git(cwd, ['commit', '-m', 'base']);
    git(cwd, ['checkout', '-b', 'feature']);
    const declaration = ['export const client', 'Secret: string = "material-value-456";\n'].join('');
    writeFileSync(join(cwd, 'source.ts'), declaration);
    assert.throws(() => collectBranchDiff('main', cwd), /secret-bearing tracked diff/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const [provider, token] of [
  ['OpenAI', ['sk-', 'D'.repeat(32)].join('')],
  ['npm', ['npm_', 'E'.repeat(36)].join('')],
  ['GitLab', ['glpat-', 'F'.repeat(24)].join('')],
] as const) {
  test(`newFilePatch — refuses a standalone ${provider} token in generic text`, () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-provider-token-'));
    try {
      writeFileSync(join(root, 'notes.txt'), `${token}\n`);
      assert.throws(() => newFilePatch(root, 'notes.txt'), /secret-bearing untracked content/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('newFilePatch — refuses a current-format Azure DevOps PAT without contextual keywords', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-ado-pat-'));
  try {
    const token = ['A'.repeat(75), 'AZDO', 'B'.repeat(5)].join('');
    writeFileSync(join(root, 'notes.txt'), `${token}\n`);
    assert.throws(() => newFilePatch(root, 'notes.txt'), /Azure DevOps PAT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — refuses a legacy 52-character Azure DevOps PAT with PAT context', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-legacy-ado-pat-'));
  try {
    const token = 'C'.repeat(52);
    writeFileSync(join(root, 'settings.txt'), `azureDevOpsPat = ${token}\n`);
    assert.throws(() => newFilePatch(root, 'settings.txt'), /legacy Azure DevOps PAT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('newFilePatch — permits an unlabelled 52-character alphanumeric digest', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-dogfood-digest-'));
  try {
    const digest = 'D'.repeat(52);
    writeFileSync(join(root, 'digest.txt'), `${digest}\n`);
    assert.doesNotThrow(() => newFilePatch(root, 'digest.txt'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});