import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { detectProvider, resolvePr } from '../src/providers/index.js';
import { GitHubProvider } from '../src/providers/github.js';
import { AzureDevOpsProvider } from '../src/providers/azuredevops.js';
import { gatherCachePath, CACHE_ROOT } from '../src/cache/keys.js';

// The URL from the field report that motivated this file: detection accepted
// it, parse rejected it, and the error only surfaced inside the detached child.
const LEGACY_ADO_URL =
  'https://microsoft.visualstudio.com/DefaultCollection/RDV/_git/rdinfra/pullrequest/16459916';

// Always pass hosts explicitly so tests never read the user's real config.
const NO_HOSTS = {};

test('detectProvider — cloud hostnames, config map, and path-shape heuristic', () => {
  const cases: Array<{ url: string; expect: 'github' | 'azuredevops'; hosts?: Record<string, 'github' | 'azuredevops'> }> = [
    { url: 'https://github.com/o/r/pull/1', expect: 'github' },
    { url: 'HTTPS://WWW.GITHUB.COM/o/r/pull/1', expect: 'github' },
    { url: 'https://dev.azure.com/org/p/_git/r/pullrequest/2', expect: 'azuredevops' },
    { url: LEGACY_ADO_URL, expect: 'azuredevops' },
    // Unknown hosts: the path shape decides.
    { url: 'https://github.mycorp.com/o/r/pull/5', expect: 'github' },
    { url: 'https://tfs.corp.com/tfs/DC/P/_git/r/pullrequest/7', expect: 'azuredevops' },
    // Explicit config mapping wins for a host whose path proves nothing.
    { url: 'https://scm.corp.com/o/r/pull/9', expect: 'github', hosts: { 'scm.corp.com': 'github' } },
  ];
  for (const c of cases) {
    assert.equal(detectProvider(c.url, c.hosts ?? NO_HOSTS).name, c.expect, c.url);
  }
});

test('detectProvider — unrecognized host without a PR-shaped path names the hosts: config fix', () => {
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
    project: string;
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
      // Project-omitted form (project == repo).
      url: 'https://dev.azure.com/org/_git/repo/pullrequest/9',
      organization: 'org', project: 'repo', repo: 'repo', number: 9,
      baseUrl: 'https://dev.azure.com/org',
    },
    {
      // The exact URL from the field report.
      url: LEGACY_ADO_URL,
      organization: 'microsoft', project: 'RDV', repo: 'rdinfra', number: 16459916,
      baseUrl: 'https://microsoft.visualstudio.com',
    },
    {
      url: 'https://org.visualstudio.com/Proj/_git/repo/pullrequest/3',
      organization: 'org', project: 'Proj', repo: 'repo', number: 3,
      baseUrl: 'https://org.visualstudio.com',
    },
    {
      url: 'https://org.visualstudio.com/_git/repo/pullrequest/3',
      organization: 'org', project: 'repo', repo: 'repo', number: 3,
      baseUrl: 'https://org.visualstudio.com',
    },
    {
      url: 'https://org.visualstudio.com/DefaultCollection/_git/repo/pullrequest/3',
      organization: 'org', project: 'repo', repo: 'repo', number: 3,
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

test('resolvePr — the field-report URL resolves end to end', () => {
  const { provider, ref } = resolvePr(LEGACY_ADO_URL, NO_HOSTS);
  assert.equal(provider.name, 'azuredevops');
  assert.equal(ref.number, 16459916);
});

test('resolvePr — a malformed visualstudio.com URL suggests the canonical dev.azure.com form', () => {
  assert.throws(
    () => resolvePr('https://org.visualstudio.com/a/b/c/_git/repo/pullrequest/1', NO_HOSTS),
    /dev\.azure\.com\/<org>\/<project>/,
  );
});

// Tripwire: cache paths for the canonical cloud URLs must never change, or
// every user's existing gather cache is silently orphaned.
test('cache-path stability — canonical cloud URLs produce the same paths as before this refactor', () => {
  const gh = new GitHubProvider().parseUrl('https://github.com/octo/repo/pull/42')!;
  assert.equal(
    gatherCachePath(gh, 'abcdef123456deadbeef', '77'),
    join(CACHE_ROOT, 'github', 'octo__repo', '42', 'abcdef123456-77.json'),
  );
  const ado = new AzureDevOpsProvider().parseUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/9')!;
  assert.equal(
    gatherCachePath(ado, 'abcdef123456deadbeef', 'none'),
    join(CACHE_ROOT, 'azuredevops', 'org__repo', '9', 'abcdef123456-none.json'),
  );
});
