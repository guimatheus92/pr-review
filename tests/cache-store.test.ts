import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from '../src/cache/store.js';
import type { GatherOutput, PrRef } from '../src/types.js';

function seed(root: string, scope: string, ref: PrRef): string {
  const dir = join(root, 'azuredevops', scope, String(ref.number));
  mkdirSync(dir, { recursive: true });
  const gather = {
    pr: ref, metadata: { headSha: 'abcdef1234567890' }, changedFiles: [],
    existingComments: [], gatheredAt: '',
  } as unknown as GatherOutput;
  writeFileSync(join(dir, 'abcdef123456-none.json'), JSON.stringify(gather), 'utf8');
  return dir;
}

test('clearCache — a project-omitted ADO ref clears matching project scopes only', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-cache-clear-'));
  const unresolved: PrRef = {
    provider: 'azuredevops', url: 'https://dev.azure.com/org/_git/repo/pullrequest/9',
    owner: 'org', organization: 'org', repo: 'repo', number: 9,
  };
  try {
    const projectA = seed(root, 'org__ProjectA__repo', { ...unresolved, project: 'ProjectA' });
    const projectB = seed(root, 'org__ProjectB__repo', { ...unresolved, project: 'ProjectB' });
    const otherRepo = seed(root, 'org__ProjectA__other', { ...unresolved, repo: 'other', project: 'ProjectA' });
    const misleading = seed(root, 'org__NotRepo__repo', { ...unresolved, repo: 'different', project: 'NotRepo' });

    const result = clearCache({ prRef: unresolved, rootOverride: root });
    assert.equal(result.removedFiles, 2);
    assert.equal(existsSync(projectA), false);
    assert.equal(existsSync(projectB), false);
    assert.equal(existsSync(otherRepo), true);
    assert.equal(existsSync(misleading), true, 'scope name alone is not enough to delete a cache entry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});