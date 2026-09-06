import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapGitHubStatus } from '../src/providers/github.js';
import { classifyChange } from '../src/providers/azuredevops.js';
import { mapDiff } from '../src/providers/gitlab.js';
import { GIT_STATUS } from '../src/commands/gather.js';
import { gatherFromPatch } from '../scripts/gather-from-patch.mjs';
import type { ChangedFile } from '../src/types.js';

/**
 * The whole vocabulary, spelled out rather than derived: `ChangedFile['status']`
 * is a type, so nothing at runtime can enumerate it. A value added to the union
 * without a line here is a value no provider is proven to emit.
 */
const VOCABULARY = new Set<ChangedFile['status']>(['added', 'modified', 'deleted', 'renamed']);

/** The unknown-status path writes to stderr by design; without this the suite prints real `[gather]` warnings that read as failures. */
function captureStderr(fn: () => void): string[] {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as { write: unknown }).write = original;
  }
  return written;
}

/**
 * Every producer of a ChangedFile, at its narrowest testable seam, with the raw
 * vocabulary each one derives `status` from — GitHub's seven strings, ADO's
 * bitmask, GitLab's booleans, git's name-status letters. A cast used to launder
 * GitHub's four non-union values straight into the type (#29).
 *
 * For the four TypeScript producers, read this as the inventory rather than the
 * enforcement: each seam declares `ChangedFile['status']` as its return type, so
 * tsc already rejects an off-vocabulary literal, and what a row can still catch is
 * a value produced by a path the type cannot see (an internal cast, or a lookup
 * resolving through Object.prototype, which has its own test below). Their teeth
 * are the per-provider `fetchChangedFiles` tests, which cover the call sites where
 * the bug actually was.
 *
 * `scripts/gather-from-patch.mjs` is the exception and the reason this table is
 * not merely documentation: it is plain JS feeding `--from-gather` for the eval
 * harness and dogfood runs, so NO type checks it at all. For that producer this
 * row is the only thing standing between a typo and an off-vocabulary status.
 */
test('every provider maps its own vocabulary onto ChangedFile["status"] — nothing else', () => {
  const emitted: [string, ChangedFile['status']][] = [
    // GitHub — the full documented enum of pulls/:n/files (@octokit/openapi-types,
    // components["schemas"]["diff-entry"]). Four are NOT in ChangedFile: removed,
    // copied, changed, unchanged.
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

    // The eval/dogfood harness — untyped JS, so this row is a real check, not an inventory.
    ...gatherFromPatch(
      [
        'diff --git a/m.ts b/m.ts',
        '--- a/m.ts',
        '+++ b/m.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/n.ts b/n.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@ -0,0 +1 @@',
        '+x',
        'diff --git a/d.ts b/d.ts',
        'deleted file mode 100644',
        '--- a/d.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-x',
        'diff --git a/before.ts b/after.ts',
        'similarity index 90%',
        'rename from before.ts',
        'rename to after.ts',
        '--- a/before.ts',
        '+++ b/after.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    ).changedFiles.map((f): [string, ChangedFile['status']] => [`gather-from-patch ${f.path}`, f.status]),
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
  captureStderr(() => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(mapGitHubStatus(key), 'modified', `${key} must degrade, not resolve`);
    }
  });
});

test('an unrecognized GitHub status degrades to "modified" and says so on stderr', () => {
  // GitHub can add an eighth value; the review must not die over a field whose only
  // consumer renders it as prose. But it must not diverge in silence either — that
  // is the bug this file exists to prevent.
  //
  // The warn-once Set is module-global with no reset seam, so this asserts on a
  // value used nowhere else in the file; node:test runs each file in its own
  // process, so no other test file can have warmed it either.
  const written = captureStderr(() => {
    assert.equal(mapGitHubStatus('exploded'), 'modified');
    assert.equal(mapGitHubStatus('exploded'), 'modified');
  });
  const warnings = written.filter((line) => line.includes('exploded'));
  assert.equal(warnings.length, 1, 'one warning per distinct unknown status, not one per file');
  assert.match(warnings[0]!, /unknown GitHub file status/);
});

test('an unknown status cannot forge a log line', () => {
  // The value is remote text going to stderr; a newline in it would let a crafted
  // status write its own `[gather] …` line. printable() strips control characters.
  const written = captureStderr(() => {
    assert.equal(mapGitHubStatus('x\n[gather] all files reviewed clean'), 'modified');
  });
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

test('an absent or non-string status degrades instead of throwing', () => {
  // `raw` is typed string but arrives over the wire. printable() on undefined is a
  // TypeError, which would kill the gather from inside an unrelated module.
  const written = captureStderr(() => {
    assert.equal(mapGitHubStatus(undefined), 'modified');
    assert.equal(mapGitHubStatus(null), 'modified');
    assert.equal(mapGitHubStatus(7), 'modified');
  });
  assert.equal(written.length, 3);
});

test('the warn-once set is capped, so remote text cannot flood the log it protects', () => {
  // The dedupe key is provider-controlled: a response with a different bogus status
  // per entry would otherwise print one line per file — the exact flood the Set
  // exists to prevent — and retain one string per file for the process's life.
  const written = captureStderr(() => {
    for (let i = 0; i < 50; i++) assert.equal(mapGitHubStatus(`bogus-${i}`), 'modified');
  });
  const named = written.filter((line) => line.includes('bogus-'));
  const suppressed = written.filter((line) => line.includes('suppressed'));
  assert.ok(named.length <= 10, `capped at 10, saw ${named.length}`);
  assert.equal(suppressed.length, 1, 'says once that it stopped, rather than going quiet');
});
