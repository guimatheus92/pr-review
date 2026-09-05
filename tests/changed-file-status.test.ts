import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapGitHubStatus } from '../src/providers/github.js';
import { classifyChange } from '../src/providers/azuredevops.js';
import { mapDiff } from '../src/providers/gitlab.js';
import { GIT_STATUS } from '../src/commands/gather.js';
import type { ChangedFile } from '../src/types.js';

/**
 * The whole vocabulary, spelled out rather than derived: `ChangedFile['status']`
 * is a type, so nothing at runtime can enumerate it. A value added to the union
 * without a line here is a value no provider is proven to emit.
 */
const VOCABULARY = new Set<ChangedFile['status']>(['added', 'modified', 'deleted', 'renamed']);

/**
 * Every producer of a ChangedFile, at its narrowest testable seam. `status` is a
 * closed 4-value union, but each provider derives it from its own wider
 * vocabulary — GitHub ships SEVEN values, and a cast used to launder the other
 * three straight into the type (#29). The type system only guards the literals a
 * provider writes down; the raw strings and bitmasks it receives are checked here.
 *
 * The other half of the guarantee is compile-time: `src/providers/github.ts` maps
 * instead of casting, so a new provider assigning an off-vocabulary literal fails
 * `npm run build` rather than reaching this file.
 */
test('every provider maps its own vocabulary onto ChangedFile["status"] — nothing else', () => {
  const emitted: [string, ChangedFile['status']][] = [
    // GitHub — the full documented enum of pulls/:n/files (@octokit/openapi-types,
    // components["schemas"]["diff-entry"]). Four of these are NOT in ChangedFile.
    ['github added', mapGitHubStatus('added')],
    ['github removed', mapGitHubStatus('removed')],
    ['github modified', mapGitHubStatus('modified')],
    ['github renamed', mapGitHubStatus('renamed')],
    ['github copied', mapGitHubStatus('copied')],
    ['github changed', mapGitHubStatus('changed')],
    ['github unchanged', mapGitHubStatus('unchanged')],

    // Azure DevOps — VersionControlChangeType bitmask; edits arrive OR-ed with rename.
    ['ado add(1)', classifyChange(1, 'a.ts', undefined).status],
    ['ado edit(2)', classifyChange(2, 'a.ts', undefined).status],
    ['ado rename(8)', classifyChange(8, 'new.ts', '/old.ts').status],
    ['ado add|rename(9)', classifyChange(9, 'new.ts', '/old.ts').status],
    ['ado edit|rename(10)', classifyChange(10, 'new.ts', '/old.ts').status],
    ['ado delete(16)', classifyChange(16, 'a.ts', undefined).status],
    ['ado delete|rename(24)', classifyChange(24, 'gone.ts', '/was.ts').status],
    ['ado none(undefined)', classifyChange(undefined, 'a.ts', undefined).status],

    // GitLab — three booleans on the diff entry.
    ['gitlab new_file', mapDiff({ old_path: 'a.ts', new_path: 'a.ts', new_file: true, deleted_file: false, renamed_file: false, diff: '' }).status],
    ['gitlab deleted_file', mapDiff({ old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: true, renamed_file: false, diff: '' }).status],
    ['gitlab renamed_file', mapDiff({ old_path: 'o.ts', new_path: 'n.ts', new_file: false, deleted_file: false, renamed_file: true, diff: '' }).status],
    ['gitlab plain', mapDiff({ old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: false, renamed_file: false, diff: '' }).status],

    // git — the name-status letters runGather completes a truncated list with.
    ...Object.entries(GIT_STATUS).map(([code, status]): [string, ChangedFile['status']] => [`git ${code}`, status]),
  ];

  for (const [source, status] of emitted) {
    assert.ok(VOCABULARY.has(status), `${source} emitted "${status}", which is not a ChangedFile["status"]`);
  }
});

test('GitHub maps its seven statuses onto the four — a deletion is "deleted", not "removed"', () => {
  // The cast this replaces made every GitHub deletion carry "removed": a status-based
  // decision would have read it as neither deleted nor modified, silently, on one
  // provider only.
  assert.equal(mapGitHubStatus('removed'), 'deleted');
  assert.equal(mapGitHubStatus('added'), 'added');
  assert.equal(mapGitHubStatus('modified'), 'modified');
  assert.equal(mapGitHubStatus('renamed'), 'renamed');
  // A copy has no base content at this path, exactly like an add — the same call
  // git's own mapping makes (`C: 'added'` in src/commands/gather.ts).
  assert.equal(mapGitHubStatus('copied'), 'added');
  // "changed" is a content change GitHub reports separately from "modified".
  assert.equal(mapGitHubStatus('changed'), 'modified');
  // NOT skipped, deliberately: dropping the row would shorten changedFiles, and
  // runGather compares its length to the PR's changed_files with STRICT equality
  // (listIsIncomplete) — a skipped row would send every such PR down the
  // complete-from-git path, or refuse it outright with exit 2.
  assert.equal(mapGitHubStatus('unchanged'), 'modified');
});

test('a raw status never resolves through Object.prototype', () => {
  // The lookup key is a remote string. A plain object literal would answer
  // `constructor` with a function and `__proto__` with an object — both truthy,
  // both returned as a status, neither in the union. A Map has no such members.
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(mapGitHubStatus(key), 'modified', `${key} must degrade, not resolve`);
  }
});

test('an unrecognized GitHub status degrades to "modified" and says so on stderr', () => {
  // GitHub can add an eighth value; the review must not die over a field whose only
  // consumer renders it as prose. But it must not diverge in silence either — that
  // is the bug this file exists to prevent.
  //
  // The warn-once Set is module-global with no reset seam, so this asserts on a
  // value used nowhere else in the file; node:test runs each file in its own
  // process, so no other test file can have warmed it either.
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    assert.equal(mapGitHubStatus('exploded'), 'modified');
    assert.equal(mapGitHubStatus('exploded'), 'modified');
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  const warnings = written.filter((line) => line.includes('exploded'));
  assert.equal(warnings.length, 1, 'one warning per distinct unknown status, not one per file');
  assert.match(warnings[0]!, /unknown GitHub file status/);
});

test('an unknown status cannot forge a log line', () => {
  // The value is remote text going to stderr; a newline in it would let a crafted
  // status write its own `[gather] …` line. printable() strips control characters.
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    assert.equal(mapGitHubStatus('x\n[gather] all files reviewed clean'), 'modified');
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  assert.equal(written.length, 1);
  assert.equal(written[0]!.split('\n').filter(Boolean).length, 1, 'one line out, whatever came in');
  assert.match(written[0]!, /'x\[gather\] all files reviewed clean'/);
});

test('Azure DevOps labels a rename "renamed" and carries the old path', () => {
  // ADO reported every rename as "modified" and never set previousPath, so the
  // repo-config trust gate (gatherChangesRepoConfig checks path AND previousPath)
  // could not see a .pr-review.yaml renamed away on ADO alone.
  assert.equal(classifyChange(8, 'new/name.ts', '/old/name.ts').status, 'renamed');
  assert.equal(classifyChange(10, 'new/name.ts', '/old/name.ts').status, 'renamed');
  // Precedence is unchanged on purpose: delete and add still win, so the content
  // fetches guarded by `status !== 'deleted'` / `!== 'added'` behave identically.
  assert.equal(classifyChange(16 | 8, 'a.ts', '/o.ts').status, 'deleted');
  assert.equal(classifyChange(1 | 8, 'a.ts', '/o.ts').status, 'added');
});
