import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshCachedGatherIdentity, runGather } from '../src/commands/gather.js';
import type { ChangedFile, GatherOutput, PrMetadata, PrRef } from '../src/types.js';
import type { PrProvider } from '../src/providers/types.js';

test('refreshCachedGatherIdentity — authoritative ADO project upgrades a stale cached payload', () => {
  const stale = {
    pr: {
      provider: 'azuredevops', url: 'https://dev.azure.com/org/_git/repo/pullrequest/9',
      owner: 'org', organization: 'org', repo: 'repo', number: 9,
    },
    metadata: {}, changedFiles: [], fullDiff: '', existingComments: [], gatheredAt: '',
  } as unknown as GatherOutput;
  const current = {
    ...stale.pr,
    project: 'ProjectA',
    baseUrl: 'https://dev.azure.com/org',
  };

  const refreshed = refreshCachedGatherIdentity(stale, current);
  assert.equal(refreshed.pr.project, 'ProjectA');
  assert.equal(refreshed.pr.baseUrl, 'https://dev.azure.com/org');
  assert.equal(stale.pr.project, undefined, 'cache data is not mutated in place');
});

test('runGather — unresolved ADO project bypasses stale cache reads and fresh cache writes', async () => {
  const nonce = `unresolved-${process.pid}-${Date.now()}`;
  const ref: PrRef = {
    provider: 'azuredevops', url: `https://dev.azure.com/${nonce}/_git/repo/pullrequest/9`,
    owner: nonce, organization: nonce, repo: 'repo', number: 9,
  };
  const metadata = {
    title: 't', description: 'description', author: 'a', headSha: 'abcdef1234567890', baseSha: 'base',
    baseBranch: 'main', headBranch: 'feature', labels: [], linkedItems: [], createdAt: '', updatedAt: '',
    isDraft: false, state: 'open' as const,
  };
  let changedFileReads = 0;
  let cacheReads = 0;
  let cacheWrites = 0;
  const provider: PrProvider = {
    name: 'azuredevops', authEnv: () => ({}), parseUrl: () => ({ ...ref }),
    fetchMetadata: async () => metadata,
    fetchChangedFiles: async () => {
      changedFileReads++;
      return [{ path: 'fresh.ts', status: 'modified', additions: 1, deletions: 0 }];
    },
    fetchFullDiff: async () => 'fresh', fetchExistingComments: async () => [],
    postLineComment: async () => null, isTransientError: () => false,
  };
  const result = await runGather({
    prUrl: ref.url,
    provider,
    readGatherCacheFn: () => {
      cacheReads++;
      throw new Error('unresolved ADO cache must not be read');
    },
    writeGatherCacheFn: () => {
      cacheWrites++;
      throw new Error('unresolved ADO cache must not be written');
    },
  });
  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 0);
  assert.equal(changedFileReads, 1);
  assert.deepEqual(result.changedFiles.map((file) => file.path), ['fresh.ts']);
});

test('runGather — filtered legacy cache is bypassed and replaced with raw provider data', async () => {
  const ref: PrRef = { provider: 'github', url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 };
  const metadata = {
    title: 't', description: 'description', author: 'a', headSha: 'abcdef1234567890', baseSha: 'base',
    baseBranch: 'main', headBranch: 'feature', labels: [], linkedItems: [], createdAt: '', updatedAt: '',
    isDraft: false, state: 'open' as const,
  };
  const legacy = {
    pr: ref, metadata,
    changedFiles: [
      { path: '.pr-review.yaml', status: 'modified' as const, additions: 1, deletions: 0, patch: '@@\n+x' },
      { path: 'src/app.ts', status: 'modified' as const, additions: 1, deletions: 0, excluded: true, excludedReason: 'old' },
    ],
    fullDiff: 'old', existingComments: [], gatheredAt: '',
  };
  let fetches = 0;
  let cached: GatherOutput | undefined;
  const provider: PrProvider = {
    name: 'github', authEnv: () => ({}), parseUrl: () => ({ ...ref, baseUrl: 'https://api.github.com' }),
    fetchMetadata: async () => metadata,
    fetchChangedFiles: async () => {
      fetches++;
      return [
        { path: '.pr-review.yaml', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+x' },
        { path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+fresh' },
      ];
    },
    fetchFullDiff: async () => 'fresh', fetchExistingComments: async () => [],
    postLineComment: async () => null, isTransientError: () => false,
  };
  const result = await runGather({
    prUrl: ref.url,
    provider,
    readGatherCacheFn: () => ({ data: legacy, path: 'legacy.json', ageMs: 1 }),
    writeGatherCacheFn: (value) => (cached = value, 'new.json'),
  });
  assert.equal(fetches, 1);
  assert.equal(result.changedFiles.find((file) => file.path === 'src/app.ts')?.patch, '@@\n+fresh');
  assert.equal(cached?.changedFiles.some((file) => file.excluded), false);
  assert.equal(cached?.changedFiles.find((file) => file.path === 'src/app.ts')?.patch, '@@\n+fresh');
});
// Provider file-list completeness (issue #23): GitHub's pulls/files stops at 3000
// entries silently, ADO's iteration changes page at 100 by default and GitLab
// reports "N+" for a truncated stored diff. The list feeds every trust gate keyed
// on changedPaths, so a short list is unknown, never "nothing else changed":
// gather completes it from the local checkout or fails before anything is cached.

const GH_REF: PrRef = { provider: 'github', url: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1 };
const META: PrMetadata = {
  title: 't', description: 'd', author: 'a', headSha: 'abcdef1234567890', baseSha: 'base0123456789ab',
  baseBranch: 'main', headBranch: 'feature', labels: [], linkedItems: [], createdAt: '', updatedAt: '',
  isDraft: false, state: 'open',
};
const file = (path: string): ChangedFile => ({ path, status: 'modified', additions: 1, deletions: 0, patch: '@@\n+x' });

function fakeGithub(metadata: PrMetadata, files: ChangedFile[]): { provider: PrProvider; fetches: () => number } {
  let fetches = 0;
  const provider: PrProvider = {
    name: 'github', authEnv: () => ({}), parseUrl: () => ({ ...GH_REF, baseUrl: 'https://api.github.com' }),
    fetchMetadata: async () => metadata,
    fetchChangedFiles: async () => { fetches++; return files; },
    fetchFullDiff: async () => '', fetchExistingComments: async () => [],
    postLineComment: async () => null, isTransientError: () => false,
  };
  return { provider, fetches: () => fetches };
}

function withNoRepoDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-gather-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('runGather — a provider list shorter than the provider\'s own count is refused and never cached', async () => {
  const { provider } = fakeGithub({ ...META, changedFileCount: 3 }, [file('a.ts')]);
  let writes = 0;
  await withNoRepoDir(async (cwd) => {
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd, readGatherCacheFn: () => null, writeGatherCacheFn: () => (writes++, 'x') }),
      /listed 1 of 3 changed files/,
    );
  });
  assert.equal(writes, 0, 'a truncated gather must never reach the cache');
});

test('runGather — a list matching the count passes and the cache entry carries the completeness marker', async () => {
  const { provider } = fakeGithub({ ...META, changedFileCount: 2 }, [file('a.ts'), file('b.ts')]);
  let cached: GatherOutput | undefined;
  const result = await runGather({ prUrl: GH_REF.url, provider, readGatherCacheFn: () => null, writeGatherCacheFn: (v) => (cached = v, 'x') });
  assert.equal(result.changedFiles.length, 2);
  assert.equal(cached?.changedFilesComplete, true, 'only a list that passed the gate is marked complete');
});

test('runGather — a provider-declared truncation ("N+") is refused even when the list length equals N', async () => {
  // GitLab serves exactly the stored, capped set for "N+": a length comparison is a tautology there.
  const files = Array.from({ length: 1000 }, (_, i) => file(`f${i}.ts`));
  const { provider } = fakeGithub({ ...META, changedFileCount: 1000, changedFileListTruncated: true }, files);
  await withNoRepoDir(async (cwd) => {
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /reports the list as truncated/,
    );
  });
});

test('runGather — a cache entry without the completeness marker predates the gate and is refetched once', async () => {
  // 0.6–0.10 cached ADO lists cut at 100 files raw, under a key the upgrade does not rotate.
  const { provider, fetches } = fakeGithub(META, [file('a.ts'), file('b.ts')]);
  const stale = { pr: GH_REF, metadata: META, changedFiles: [file('a.ts')], fullDiff: '', existingComments: [], gatheredAt: '' };
  let cached: GatherOutput | undefined;
  const result = await runGather({
    prUrl: GH_REF.url, provider,
    readGatherCacheFn: () => ({ data: stale as GatherOutput, path: 'stale.json', ageMs: 1 }),
    writeGatherCacheFn: (v) => (cached = v, 'x'),
  });
  assert.equal(fetches(), 1);
  assert.deepEqual(result.changedFiles.map((f) => f.path), ['a.ts', 'b.ts']);
  assert.equal(cached?.changedFilesComplete, true, 'the rewritten entry self-heals');

  const fresh = fakeGithub(META, [file('a.ts'), file('b.ts')]);
  const hit = { ...stale, changedFiles: [file('a.ts'), file('b.ts')], changedFilesComplete: true as const };
  await runGather({ prUrl: GH_REF.url, provider: fresh.provider, readGatherCacheFn: () => ({ data: hit, path: 'hit.json', ageMs: 1 }), writeGatherCacheFn: () => 'x' });
  assert.equal(fresh.fetches(), 0, 'a marked entry is served as before');
});

// Completing a truncated list from the local checkout.

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** base: a.ts c.ts d.ts → head: edit a.ts, add b.ts + a rule with a non-ASCII name, rename c→e, delete d, add a lockfile. */
function prRepo(origin = 'https://github.com/o/r.git'): { repo: string; baseSha: string; headSha: string } {
  const repo = mkdtempSync(join(tmpdir(), 'pr-review-complete-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  for (const name of ['a.ts', 'c.ts', 'd.ts']) writeFileSync(join(repo, name), `${name}\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const baseSha = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.ts'), 'a.ts\nedited\n');
  writeFileSync(join(repo, 'b.ts'), 'new\n');
  mkdirSync(join(repo, '.claude', 'rules'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'rules', 'régle.md'), 'rule\n');
  git(repo, 'mv', 'c.ts', 'e.ts');
  rmSync(join(repo, 'd.ts'));
  writeFileSync(join(repo, 'package-lock.json'), '{}\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  const headSha = git(repo, 'rev-parse', 'HEAD');
  return { repo, baseSha, headSha };
}

test('runGather — a truncated list is completed from the PR\'s checkout: raw paths, renames, patches, exclusions, cache', async () => {
  const { repo, baseSha, headSha } = prRepo();
  try {
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 6 }, [{ ...file('a.ts'), patch: '@@\n+provider' }]);
    let cached: GatherOutput | undefined;
    const result = await runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: (v) => (cached = v, 'x') });
    const by = (p: string) => result.changedFiles.find((f) => f.path === p)!;
    assert.deepEqual(
      result.changedFiles.map((f) => f.path).sort(),
      ['.claude/rules/régle.md', 'a.ts', 'b.ts', 'd.ts', 'e.ts', 'package-lock.json'],
      'non-ASCII paths arrive raw (-z), never C-quoted',
    );
    assert.equal(by('a.ts').patch, '@@\n+provider', 'the provider entry wins over the git one');
    assert.equal(by('b.ts').status, 'added');
    assert.ok(by('b.ts').patch?.startsWith('@@ -0,0 +1'), `hunks-only patch, got ${JSON.stringify(by('b.ts').patch)}`);
    assert.equal(by('b.ts').additions, 1);
    assert.equal(by('e.ts').status, 'renamed');
    assert.equal(by('e.ts').previousPath, 'c.ts');
    assert.equal(by('e.ts').patch, undefined, 'a pure rename has no hunk');
    assert.equal(by('d.ts').status, 'deleted');
    assert.equal(by('d.ts').deletions, 1);
    assert.equal(by('.claude/rules/régle.md').status, 'added');
    assert.equal(by('package-lock.json').excluded, true, 'exclusions apply to git-completed rows too');
    assert.equal(cached?.changedFiles.length, 6);
    assert.equal(cached?.changedFiles.some((f) => f.excluded), false, 'the cache stays raw');
    assert.equal(cached?.changedFilesComplete, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a missing commit names the provider-specific fetch command; pr-review never fetches', async () => {
  const { repo, baseSha } = prRepo();
  try {
    const absent = 'f'.repeat(40);
    const gh = fakeGithub({ ...META, baseSha, headSha: absent, changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider: gh.provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      (err: Error) => /is not in this checkout/.test(err.message) && /git fetch origin main refs\/pull\/1\/head/.test(err.message) && /never fetches/.test(err.message),
    );
    const glRef: PrRef = { provider: 'gitlab', url: 'https://gitlab.com/o/r/-/merge_requests/7', owner: 'o', repo: 'r', number: 7 };
    const gl: PrProvider = { ...gh.provider, name: 'gitlab', parseUrl: () => ({ ...glRef }) };
    await assert.rejects(
      () => runGather({ prUrl: glRef.url, provider: gl, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /git fetch origin refs\/merge-requests\/7\/head/,
    );
    const adoRef: PrRef = { provider: 'azuredevops', url: 'https://dev.azure.com/o/p/_git/r/pullrequest/3', owner: 'o', organization: 'o', project: 'p', repo: 'r', number: 3 };
    const ado: PrProvider = { ...gh.provider, name: 'azuredevops', parseUrl: () => ({ ...adoRef }) };
    await assert.rejects(
      () => runGather({ prUrl: adoRef.url, provider: ado, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /git fetch origin main feature/,
    );
    // A refname may carry shell metacharacters (never a space): only then is it quoted, so the plain form still pastes into cmd.exe.
    const odd = fakeGithub({ ...META, baseSha, headSha: absent, baseBranch: 'rel;ease$(x)', changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider: odd.provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /git fetch origin 'rel;ease\$\(x\)' refs\/pull\/1\/head/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a checkout of another repository cannot complete the list', async () => {
  const { repo, baseSha, headSha } = prRepo('https://github.com/other/x.git');
  try {
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /is not the PR's repository o\/r/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a criss-cross history (two merge bases) is refused: git and the provider may diff against different bases', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pr-review-crisscross-'));
  try {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
    writeFileSync(join(repo, 'base.ts'), 'base\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'c0');
    git(repo, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(repo, 'side.ts'), 'side\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'side');
    git(repo, 'checkout', '-q', 'main');
    writeFileSync(join(repo, 'main.ts'), 'main\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main');
    git(repo, 'merge', '-q', '--no-edit', 'side'); // main: merge(main, side)
    git(repo, 'checkout', '-q', 'side');
    git(repo, 'merge', '-q', '--no-edit', 'main~1'); // side: merge(side, main) → two merge bases with main
    const headSha = git(repo, 'rev-parse', 'side');
    const baseSha = git(repo, 'rev-parse', 'main');
    assert.equal(git(repo, 'merge-base', '--all', baseSha, headSha).split('\n').length, 2, 'fixture really is criss-cross');
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 5 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /merge bases/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — reviewer diff config and the PR\'s own attributes cannot reshape the completed list; a subdirectory cwd still sees the whole tree', async () => {
  const { repo, baseSha, headSha } = prRepo();
  const cfg = join(repo, 'reviewer-gitconfig');
  writeFileSync(cfg, '[diff]\n\texternal = echo\n\tnoprefix = true\n\trelative = true\n[core]\n\tquotepath = true\n');
  writeFileSync(join(repo, '.gitattributes'), '*.md -diff\n'); // an untracked worktree attribute, as a checked-out PR head could carry
  mkdirSync(join(repo, 'sub'));
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  try {
    assert.equal(git(repo, 'config', '--get', 'diff.external'), 'echo', 'GIT_CONFIG_GLOBAL is honoured by this git');
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 6 }, [file('a.ts')]);
    const result = await runGather({ prUrl: GH_REF.url, provider, cwd: join(repo, 'sub'), readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' });
    const by = (p: string) => result.changedFiles.find((f) => f.path === p)!;
    assert.equal(result.changedFiles.length, 6, 'diff.relative from a subdirectory must not shrink the list');
    assert.equal(by('.claude/rules/régle.md').patch, undefined, 'a -diff attribute yields a patch-less row, never a missing path');
    assert.ok(by('b.ts').patch?.startsWith('@@'), 'diff.external / noprefix do not reach the patch');
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prev;
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a git completion that still falls short of the provider\'s count is refused, not marked complete', async () => {
  // Git can only add what the checkout sees; if the union is still shorter than an exact count, the list is still unknown.
  const { repo, baseSha, headSha } = prRepo();
  try {
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 7 }, [file('a.ts')]);
    let writes = 0;
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => (writes++, 'x') }),
      /still short \(6 of 7\)/,
    );
    assert.equal(writes, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a list LONGER than the provider\'s count is a mismatch too: completed from git when possible, otherwise refused as a disagreement', async () => {
  // GitHub is documented to report changed_files: 0 for a stuck diff while still listing files.
  const { repo, baseSha, headSha } = prRepo();
  try {
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 0 }, [file('a.ts')]);
    const result = await runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' });
    assert.equal(result.changedFiles.length, 6, 'git fills in what the count could not vouch for');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  const { provider } = fakeGithub({ ...META, changedFileCount: 0 }, [file('a.ts')]);
  await withNoRepoDir(async (cwd) => {
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      (err: Error) => /disagrees with the provider's count/.test(err.message) && !/truncated/.test(err.message),
    );
  });
});

test('runGather — a shallow clone and a provider without a base commit are refused before any diff runs', async () => {
  const { repo, baseSha, headSha } = prRepo();
  const shallow = mkdtempSync(join(tmpdir(), 'pr-review-shallow-'));
  try {
    git(shallow, 'clone', '-q', '--depth', '2', 'file://' + repo.replace(/\\/g, '/'), 'clone');
    const clone = join(shallow, 'clone');
    git(clone, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git');
    assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'true', 'fixture really is shallow');
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd: clone, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /shallow/,
    );
    const noBase = fakeGithub({ ...META, baseSha: '', headSha, changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider: noBase.provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /has not reported both base and head/,
    );
  } finally {
    rmSync(shallow, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — unrelated histories and a non-hex commit id are refused with the designed message, never a raw git error', async () => {
  const { repo, baseSha } = prRepo();
  try {
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'rm', '-rfq', '.');
    writeFileSync(join(repo, 'z.ts'), 'z\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'orphan');
    const orphanHead = git(repo, 'rev-parse', 'HEAD');
    const orphan = fakeGithub({ ...META, baseSha, headSha: orphanHead, changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider: orphan.provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      (err: Error) => /no common ancestor/.test(err.message) && !/Command failed/.test(err.message),
    );
    const odd = fakeGithub({ ...META, baseSha, headSha: '--output=owned', changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider: odd.provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /is not a hex commit id/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a provider-declared truncation ("N+") is completed from the checkout: there is no count to reach, the union is the list', async () => {
  const { repo, baseSha, headSha } = prRepo();
  try {
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 1, changedFileListTruncated: true }, [file('a.ts')]);
    let cached: GatherOutput | undefined;
    const result = await runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: (v) => (cached = v, 'x') });
    assert.equal(result.changedFiles.length, 6);
    assert.equal(cached?.changedFilesComplete, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — a partial (blobless/treeless) clone is refused: diff-tree -p would fetch objects from origin on demand', async () => {
  const { repo, baseSha, headSha } = prRepo();
  try {
    git(repo, 'config', 'extensions.partialClone', 'origin');
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 6 }, [file('a.ts')]);
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /partial clone/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('runGather — the refusal names the actual cause: no repository, no origin remote, or an origin that is another repository', async () => {
  const { provider } = fakeGithub({ ...META, changedFileCount: 3 }, [file('a.ts')]);
  await withNoRepoDir(async (cwd) => {
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /is not inside a git repository/,
    );
  });
  const bare = mkdtempSync(join(tmpdir(), 'pr-review-noorigin-'));
  try {
    git(bare, 'init', '-q', '-b', 'main');
    await assert.rejects(
      () => runGather({ prUrl: GH_REF.url, provider, cwd: bare, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' }),
      /has no 'origin' remote/,
    );
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('runGather — a path with a glob metacharacter is diffed literally: dir[1]/x.ts never receives dir1/x.ts\'s patch', async () => {
  const { repo, baseSha } = prRepo();
  try {
    mkdirSync(join(repo, 'dir[1]'));
    mkdirSync(join(repo, 'dir1'));
    writeFileSync(join(repo, 'dir[1]', 'x.ts'), 'bracketed\n');
    writeFileSync(join(repo, 'dir1', 'x.ts'), 'plain\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'globs');
    const headSha = git(repo, 'rev-parse', 'HEAD');
    const { provider } = fakeGithub({ ...META, baseSha, headSha, changedFileCount: 8 }, [file('a.ts')]);
    const result = await runGather({ prUrl: GH_REF.url, provider, cwd: repo, readGatherCacheFn: () => null, writeGatherCacheFn: () => 'x' });
    const by = (p: string) => result.changedFiles.find((f) => f.path === p)!;
    assert.ok(by('dir[1]/x.ts').patch?.includes('+bracketed'), `literal pathspec, got ${JSON.stringify(by('dir[1]/x.ts').patch)}`);
    assert.ok(by('dir1/x.ts').patch?.includes('+plain'), `plain path, got ${JSON.stringify(by('dir1/x.ts').patch)}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
