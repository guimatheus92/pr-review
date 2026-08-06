import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GitHubProvider } from '../src/providers/github.js';
import { AzureDevOpsProvider } from '../src/providers/azuredevops.js';

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

test('GitHubProvider.authEnv — env token round-trips as GITHUB_TOKEN, no subprocess', () => {
  withEnv({ GITHUB_TOKEN: 'tok' }, () => {
    assert.deepEqual(new GitHubProvider().authEnv(), { GITHUB_TOKEN: 'tok' });
  });
});

test('AzureDevOpsProvider.authEnv — PAT round-trips as AZURE_DEVOPS_PAT', () => {
  withEnv(
    { AZURE_DEVOPS_PAT: 'pat', SYSTEM_ACCESSTOKEN: undefined, AZURE_DEVOPS_EXT_PAT: undefined, AZURE_DEVOPS_BEARER: undefined },
    () => {
      assert.deepEqual(new AzureDevOpsProvider().authEnv(), { AZURE_DEVOPS_PAT: 'pat' });
    },
  );
});

test('AzureDevOpsProvider.authEnv — bearer round-trips as AZURE_DEVOPS_BEARER, never as a PAT', () => {
  withEnv(
    { AZURE_DEVOPS_PAT: undefined, SYSTEM_ACCESSTOKEN: undefined, AZURE_DEVOPS_EXT_PAT: undefined, AZURE_DEVOPS_BEARER: 'brr' },
    () => {
      assert.deepEqual(new AzureDevOpsProvider().authEnv(), { AZURE_DEVOPS_BEARER: 'brr' });
    },
  );
});
