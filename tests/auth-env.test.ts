import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GitHubProvider, resolveToken } from '../src/providers/github.js';
import { AzureDevOpsProvider } from '../src/providers/azuredevops.js';

const gh = new GitHubProvider();
const ado = new AzureDevOpsProvider();
const cloudRef = gh.parseUrl('https://github.com/o/r/pull/1')!;
const ghesRef = gh.parseUrl('https://github.mycorp.com/o/r/pull/5')!;
const adoRef = ado.parseUrl('https://dev.azure.com/org/proj/_git/repo/pullrequest/9')!;

/** Run fn with env vars temporarily set (undefined = unset), restoring after. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const NO_GH_ENV = {
  GITHUB_TOKEN: undefined,
  GH_TOKEN: undefined,
  COPILOT_GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
};

test('GitHubProvider.authEnv — cloud ref: env token round-trips as GITHUB_TOKEN, no subprocess', () => {
  withEnv({ ...NO_GH_ENV, GITHUB_TOKEN: 'tok' }, () => {
    assert.deepEqual(gh.authEnv(cloudRef), { GITHUB_TOKEN: 'tok' });
  });
});

test('GitHubProvider.authEnv — GHES ref: enterprise token round-trips as GH_ENTERPRISE_TOKEN', () => {
  withEnv({ ...NO_GH_ENV, GH_ENTERPRISE_TOKEN: 'ent' }, () => {
    assert.deepEqual(gh.authEnv(ghesRef), { GH_ENTERPRISE_TOKEN: 'ent' });
  });
});

test('GitHubProvider.authEnv — a github.com env token is NEVER used for a GHES host', () => {
  // Both set: the enterprise host must pick the enterprise token, not the
  // ubiquitous GITHUB_TOKEN — sending a cloud token to a GHES host is the
  // silent-wrong-token bug (and would 401 only inside the detached child).
  withEnv({ ...NO_GH_ENV, GITHUB_TOKEN: 'cloud', GH_ENTERPRISE_TOKEN: 'ent' }, () => {
    assert.deepEqual(gh.authEnv(ghesRef), { GH_ENTERPRISE_TOKEN: 'ent' });
  });
});

test('resolveToken — gh fallback passes --hostname for GHES and not for cloud', () => {
  const calls: string[][] = [];
  const fakeExec = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return 'cli-tok\n';
  }) as unknown as typeof import('node:child_process').execFileSync;
  withEnv(NO_GH_ENV, () => {
    assert.equal(resolveToken('github.com', fakeExec), 'cli-tok');
    assert.equal(resolveToken('github.mycorp.com', fakeExec), 'cli-tok');
  });
  assert.deepEqual(calls[0], ['gh', 'auth', 'token']);
  assert.deepEqual(calls[1], ['gh', 'auth', 'token', '--hostname', 'github.mycorp.com']);
});

test('AzureDevOpsProvider.authEnv — PAT round-trips as AZURE_DEVOPS_PAT', () => {
  withEnv(
    { AZURE_DEVOPS_PAT: 'pat', SYSTEM_ACCESSTOKEN: undefined, AZURE_DEVOPS_EXT_PAT: undefined, AZURE_DEVOPS_BEARER: undefined },
    () => {
      assert.deepEqual(ado.authEnv(adoRef), { AZURE_DEVOPS_PAT: 'pat' });
    },
  );
});

test('AzureDevOpsProvider.authEnv — bearer round-trips as AZURE_DEVOPS_BEARER, never as a PAT', () => {
  withEnv(
    { AZURE_DEVOPS_PAT: undefined, SYSTEM_ACCESSTOKEN: undefined, AZURE_DEVOPS_EXT_PAT: undefined, AZURE_DEVOPS_BEARER: 'brr' },
    () => {
      assert.deepEqual(ado.authEnv(adoRef), { AZURE_DEVOPS_BEARER: 'brr' });
    },
  );
});
