import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { detectProvider, resolvePr } from '../src/providers/index.js';
import { GitHubProvider, apiBaseFor } from '../src/providers/github.js';
import { AzureDevOpsProvider, hydrateAdoProject, orgUrlFor } from '../src/providers/azuredevops.js';
import { gatherCachePath, CACHE_ROOT } from '../src/cache/keys.js';
import { samePrIdentity } from '../src/commands/review.js';

// The URL from the field report that motivated this file: detection accepted
// it, parse rejected it, and the error only surfaced inside the detached child.
const LEGACY_ADO_URL =
  'https://contoso.visualstudio.com/DefaultCollection/Platform/_git/infra-core/pullrequest/1234567';

// Always pass hosts explicitly so tests never read the user's real config.
const NO_HOSTS = {};

test('detectProvider — cloud hostnames plus the explicit hosts: allowlist for self-hosted', () => {
  const cases: Array<{ url: string; expect: 'github' | 'azuredevops'; hosts?: Record<string, 'github' | 'azuredevops'> }> = [
    { url: 'https://github.com/o/r/pull/1', expect: 'github' },
    { url: 'HTTPS://WWW.GITHUB.COM/o/r/pull/1', expect: 'github' },
    { url: 'https://dev.azure.com/org/p/_git/r/pullrequest/2', expect: 'azuredevops' },
    { url: LEGACY_ADO_URL, expect: 'azuredevops' },
    // Self-hosted hosts resolve only through the config allowlist — a
    // credential is only ever sent to a host the user explicitly named.
    { url: 'https://github.mycorp.com/o/r/pull/5', expect: 'github', hosts: { 'github.mycorp.com': 'github' } },
    { url: 'https://tfs.corp.com/tfs/DC/P/_git/r/pullrequest/7', expect: 'azuredevops', hosts: { 'tfs.corp.com': 'azuredevops' } },
  ];
  for (const c of cases) {
    assert.equal(detectProvider(c.url, c.hosts ?? NO_HOSTS).name, c.expect, c.url);
  }
});

test('detectProvider — an unmapped host is rejected even when its path is perfectly PR-shaped (no credential exfiltration via crafted URLs)', () => {
  assert.throws(() => detectProvider('https://attacker.example/o/r/pull/1', NO_HOSTS), /hosts:/);
  assert.throws(() => detectProvider('https://attacker.example/col/proj/_git/r/pullrequest/1', NO_HOSTS), /hosts:/);
  assert.throws(() => detectProvider('https://scm.corp.com/weird/shape', NO_HOSTS), /hosts:/);
});

test('detectProvider — a non-URL fails as such, not as an unknown provider', () => {
  assert.throws(() => detectProvider('not a url', NO_HOSTS), /Not a valid URL/);
});

test('GitHubProvider.parseUrl — accepted shapes and baseUrl', () => {
  const p = new GitHubProvider();
  const base = p.parseUrl('https://github.com/octo/repo/pull/42');
  assert.deepEqual(
    { ...base },
    {
      provider: 'github',
      url: 'https://github.com/octo/repo/pull/42',
      owner: 'octo',
      repo: 'repo',
      number: 42,
      baseUrl: 'https://api.github.com',
    },
  );
  // Trailing path, query, and fragment are noise, not parse failures.
  assert.equal(p.parseUrl('https://github.com/octo/repo/pull/42/files')?.number, 42);
  assert.equal(p.parseUrl('https://github.com/octo/repo/pull/42?diff=split#discussion')?.number, 42);
  // GHES serves its API under /api/v3.
  assert.equal(
    p.parseUrl('https://github.mycorp.com/octo/repo/pull/5')?.baseUrl,
    'https://github.mycorp.com/api/v3',
  );
});

test('GitHubProvider.parseUrl — rejects non-PR URLs', () => {
  const p = new GitHubProvider();
  assert.equal(p.parseUrl('https://github.com/octo/repo/issues/1'), null);
  assert.equal(p.parseUrl('https://github.com/octo/repo/pull/abc'), null);
  assert.equal(p.parseUrl('https://github.com/octo/repo/pull/'), null);
  assert.equal(p.parseUrl('not a url'), null);
});

test('AzureDevOpsProvider.parseUrl — every accepted shape', () => {
  const p = new AzureDevOpsProvider();
  const cases: Array<{
    url: string;
    organization: string;
    project: string | undefined;
    repo: string;
    number: number;
    baseUrl: string;
  }> = [
    {
      url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/9',
      organization: 'org', project: 'proj', repo: 'repo', number: 9,
      baseUrl: 'https://dev.azure.com/org',
    },
    {
      // Project-omitted form: project stays undefined (the API resolves the
      // PR org-wide by id — a guessed project could route to the wrong one).
      url: 'https://dev.azure.com/org/_git/repo/pullrequest/9',
      organization: 'org', project: undefined, repo: 'repo', number: 9,
      baseUrl: 'https://dev.azure.com/org',
    },
    {
      // The exact URL from the field report.
      url: LEGACY_ADO_URL,
      organization: 'contoso', project: 'Platform', repo: 'infra-core', number: 1234567,
      baseUrl: 'https://contoso.visualstudio.com',
    },
    {
      url: 'https://org.visualstudio.com/Proj/_git/repo/pullrequest/3',
      organization: 'org', project: 'Proj', repo: 'repo', number: 3,
      baseUrl: 'https://org.visualstudio.com',
    },
    {
      url: 'https://org.visualstudio.com/_git/repo/pullrequest/3',
      organization: 'org', project: undefined, repo: 'repo', number: 3,
      baseUrl: 'https://org.visualstudio.com',
    },
    {
      url: 'https://org.visualstudio.com/DefaultCollection/_git/repo/pullrequest/3',
      organization: 'org', project: undefined, repo: 'repo', number: 3,
      baseUrl: 'https://org.visualstudio.com',
    },
    {
      url: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/9?_a=files',
      organization: 'org', project: 'proj', repo: 'repo', number: 9,
      baseUrl: 'https://dev.azure.com/org',
    },
    {
      // On-prem ADO Server/TFS: virtual dir + collection live in the path.
      url: 'https://tfs.corp.com/tfs/DefaultCollection/Proj/_git/repo/pullrequest/42',
      organization: 'DefaultCollection', project: 'Proj', repo: 'repo', number: 42,
      baseUrl: 'https://tfs.corp.com/tfs/DefaultCollection',
    },
  ];
  for (const c of cases) {
    const ref = p.parseUrl(c.url);
    assert.ok(ref, c.url);
    assert.equal(ref.organization, c.organization, `${c.url} organization`);
    assert.equal(ref.project, c.project, `${c.url} project`);
    assert.equal(ref.repo, c.repo, `${c.url} repo`);
    assert.equal(ref.number, c.number, `${c.url} number`);
    assert.equal(ref.baseUrl, c.baseUrl, `${c.url} baseUrl`);
    assert.equal(ref.owner, c.organization, `${c.url} owner mirrors organization`);
  }
});

test('AzureDevOpsProvider.parseUrl — rejects malformed shapes', () => {
  const p = new AzureDevOpsProvider();
  assert.equal(p.parseUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/'), null);
  assert.equal(p.parseUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/abc'), null);
  assert.equal(p.parseUrl('https://dev.azure.com/a/b/c/_git/repo/pullrequest/1'), null);
  // On-prem needs at least collection + project before _git.
  assert.equal(p.parseUrl('https://tfs.corp.com/Proj/_git/repo/pullrequest/1'), null);
});

// new URL() accepts malformed percent-escapes; parseUrl must not let the
// decode throw a URIError out of a function contracted to return null.
test('parseUrl — malformed percent-escapes never throw; the raw segment is kept', () => {
  const ado = new AzureDevOpsProvider().parseUrl('https://dev.azure.com/org/pro%zz/_git/re%zzpo/pullrequest/9');
  assert.ok(ado, 'parses instead of throwing URIError');
  assert.equal(ado.project, 'pro%zz');
  assert.equal(ado.repo, 're%zzpo');
  assert.equal(new GitHubProvider().parseUrl('https://github.com/o%zz/r/pull/1')?.owner, 'o%zz');
});

// parseUrl always sets baseUrl, but old serialized refs (pre-0.5.0 caches
// replayed by --resume) lack it. The fallback must re-derive from ref.url —
// a hardcoded cloud form would send legacy/on-prem refs to the wrong host.
test('orgUrlFor / apiBaseFor — refs without baseUrl re-derive from ref.url, cloud as last resort', () => {
  const legacy = new AzureDevOpsProvider().parseUrl(LEGACY_ADO_URL)!;
  delete legacy.baseUrl;
  assert.equal(orgUrlFor(legacy), 'https://contoso.visualstudio.com');
  const onprem = new AzureDevOpsProvider().parseUrl('https://tfs.corp.com/tfs/DC/Proj/_git/repo/pullrequest/1')!;
  delete onprem.baseUrl;
  assert.equal(orgUrlFor(onprem), 'https://tfs.corp.com/tfs/DC');
  // Hand-built ref whose url is unparseable → cloud form.
  assert.equal(
    orgUrlFor({ provider: 'azuredevops', url: 'x', owner: 'o', organization: 'o', repo: 'r', number: 1 }),
    'https://dev.azure.com/o',
  );
  const ghes = new GitHubProvider().parseUrl('https://github.mycorp.com/o/r/pull/5')!;
  delete ghes.baseUrl;
  assert.equal(apiBaseFor(ghes), 'https://github.mycorp.com/api/v3');
  assert.equal(
    apiBaseFor({ provider: 'github', url: 'x', owner: 'o', repo: 'r', number: 1 }),
    'https://api.github.com',
  );
});

test('hydrateAdoProject — project-omitted refs retain the authoritative API project', () => {
  const ref = new AzureDevOpsProvider().parseUrl('https://dev.azure.com/contoso/_git/infra-core/pullrequest/1')!;
  assert.equal(ref.project, undefined);
  hydrateAdoProject(ref, { name: 'Platform', id: 'ignored-id' });
  assert.equal(ref.project, 'Platform');
  hydrateAdoProject(ref, { name: 'Other' });
  assert.equal(ref.project, 'Platform', 'an explicit/resolved project is never overwritten');
});

test('AzureDevOpsProvider — every public PR operation hydrates a project-omitted ref before project-scoped calls', async () => {
  const provider = new AzureDevOpsProvider();
  const ref = provider.parseUrl('https://dev.azure.com/contoso/_git/infra-core/pullrequest/9')!;
  const projects: Array<string | undefined> = [];
  let prFetches = 0;
  const pr = {
    pullRequestId: 9,
    repository: { id: 'repo-id', project: { name: 'Platform' } },
    lastMergeSourceCommit: { commitId: 'head' },
    lastMergeTargetCommit: { commitId: 'base' },
  };
  const git = {
    getPullRequestById: async (_id: number, project: string | undefined) => {
      prFetches++;
      projects.push(project);
      return pr;
    },
    getThreads: async (_repo: string, _id: number, project: string | undefined) => {
      projects.push(project);
      return [];
    },
    getCommitDiffs: async (_repo: string, project: string | undefined) => {
      projects.push(project);
      return { changes: [] };
    },
    getPullRequestIterations: async (_repo: string, _id: number, project: string | undefined) => {
      projects.push(project);
      return [{ id: 1 }];
    },
    getPullRequestIterationChanges: async (_repo: string, _id: number, _iteration: number, project: string | undefined) => {
      projects.push(project);
      return { changeEntries: [], nextSkip: 0 };
    },
    createThread: async (_thread: unknown, _repo: string, _id: number, project: string | undefined) => {
      projects.push(project);
      return { id: 1 };
    },
  };
  (provider as unknown as { gitApis: Map<string, Promise<unknown>> }).gitApis.set(
    orgUrlFor(ref),
    Promise.resolve(git),
  );

  await provider.fetchExistingComments(ref);
  await provider.fetchFullDiff(ref);
  await provider.fetchChangedFiles(ref);
  await provider.postLineComment(ref, {
    severity: 'LOW', title: 't', body: 'b', file: 'src/a.cs', line: 1,
  });

  assert.equal(ref.project, 'Platform');
  assert.equal(prFetches, 1, 'the hydrated cache alias prevents a second PR fetch');
  assert.deepEqual(projects, [undefined, 'Platform', 'Platform', 'Platform', 'Platform', 'Platform']);
});

test('resolvePr — the field-report URL resolves end to end', () => {
  const { provider, ref } = resolvePr(LEGACY_ADO_URL, NO_HOSTS);
  assert.equal(provider.name, 'azuredevops');
  assert.equal(ref.number, 1234567);
});

test('resolvePr — a malformed visualstudio.com URL suggests the canonical dev.azure.com form', () => {
  assert.throws(
    () => resolvePr('https://org.visualstudio.com/a/b/c/_git/repo/pullrequest/1', NO_HOSTS),
    /dev\.azure\.com\/<org>\/<project>/,
  );
});

test('cache paths — GitHub stays stable while ADO is isolated by project', () => {
  const gh = new GitHubProvider().parseUrl('https://github.com/octo/repo/pull/42')!;
  assert.equal(
    gatherCachePath(gh, 'abcdef123456deadbeef', '77'),
    join(CACHE_ROOT, 'github', 'octo__repo', '42', 'abcdef123456-77.json'),
  );
  const ado = new AzureDevOpsProvider().parseUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/9')!;
  assert.equal(
    gatherCachePath(ado, 'abcdef123456deadbeef', 'none'),
    join(CACHE_ROOT, 'azuredevops', 'org__proj__repo', '9', 'abcdef123456-none.json'),
  );
  const otherProject = new AzureDevOpsProvider().parseUrl('https://dev.azure.com/org/other/_git/repo/pullrequest/9')!;
  assert.notEqual(
    gatherCachePath(ado, 'abcdef123456deadbeef', 'none'),
    gatherCachePath(otherProject, 'abcdef123456deadbeef', 'none'),
    'same-name repositories and PR numbers in different ADO projects have distinct cache namespaces',
  );
  const ghesA = new GitHubProvider().parseUrl('https://github-a.example/o/r/pull/9')!;
  const ghesB = new GitHubProvider().parseUrl('https://github-b.example/o/r/pull/9')!;
  assert.notEqual(
    gatherCachePath(ghesA, 'abcdef123456deadbeef', 'none'),
    gatherCachePath(ghesB, 'abcdef123456deadbeef', 'none'),
    'same owner/repo/PR on different GHES authorities have distinct cache namespaces',
  );
  assert.equal(samePrIdentity(ghesA, ghesB), false);
  assert.equal(
    samePrIdentity(
      new AzureDevOpsProvider().parseUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/9')!,
      new AzureDevOpsProvider().parseUrl('https://org.visualstudio.com/proj/_git/repo/pullrequest/9')!,
    ),
    true,
    'canonical and legacy ADO cloud forms share one authority',
  );
});

test('detectProvider — the fallback host map reads the global config, never a checkout-local .pr-review.yaml', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-hosts-sink-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-hosts-sink-home-'));
  const previous = { cwd: process.cwd(), USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  const url = 'https://trusted-sink.example/g/p/-/merge_requests/1';
  try {
    writeFileSync(join(cwd, '.pr-review.yaml'), 'hosts:\n  trusted-sink.example: gitlab\n');
    process.chdir(cwd);
    // loadConfig resolves homedir() per call, and homedir() follows USERPROFILE/HOME —
    // so the fallback reads a home this test owns, never the developer's.
    process.env.USERPROFILE = home;
    process.env.HOME = home;
    let err: unknown;
    try { detectProvider(url); } catch (e) { err = e; }
    assert.ok(err instanceof Error, 'repo-level hosts must not map an unknown host');
    assert.match(err.message, /Unrecognized PR URL/);
    assert.match(err.message, /map the host in the global config ~\/\.pr-review\/config\.yaml/);
    assert.doesNotMatch(err.message, /or \.pr-review\.yaml/, 'the tip must name the global file only');
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'hosts:\n  trusted-sink.example: gitlab\n');
    assert.equal(detectProvider(url).name, 'gitlab', 'the global map is honoured through the fallback');
  } finally {
    process.chdir(previous.cwd);
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.HOME === undefined) delete process.env.HOME; else process.env.HOME = previous.HOME;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
