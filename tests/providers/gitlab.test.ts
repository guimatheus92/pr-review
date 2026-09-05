import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import {
  GitLabProvider,
  classifyAuthor,
  isTransientGitLabError,
  mapDiff,
  positionForLine,
  buildDiscussionPosition,
  mapMrMetadata,
  mapNote,
  resolveToken,
} from '../../src/providers/gitlab.js';
import { detectProvider } from '../../src/providers/index.js';
import { gatherCachePath, CACHE_ROOT } from '../../src/cache/keys.js';
import { ensureRunDir, safeOwner, safeSegment } from '../../src/util/tmp.js';
import { validLinesFromPatch } from '../../src/dispatch/line-snap.js';
import { rmSync } from 'node:fs';
import { basename, dirname } from 'node:path';

test('GitLabProvider.parseUrl — accepted shapes, nested namespaces keep slashes', () => {
  const p = new GitLabProvider();
  const simple = p.parseUrl('https://gitlab.com/group/proj/-/merge_requests/42');
  assert.deepEqual(
    { ...simple },
    {
      provider: 'gitlab',
      url: 'https://gitlab.com/group/proj/-/merge_requests/42',
      owner: 'group',
      repo: 'proj',
      number: 42,
      baseUrl: 'https://gitlab.com/api/v4',
    },
  );
  // Nested subgroups: owner is the full namespace path.
  const nested = p.parseUrl('https://gitlab.com/group/sub/deep/proj/-/merge_requests/7');
  assert.equal(nested?.owner, 'group/sub/deep');
  assert.equal(nested?.repo, 'proj');
  // Legacy form without /-/.
  assert.equal(p.parseUrl('https://gitlab.com/group/proj/merge_requests/9')?.number, 9);
  // Trailing junk.
  assert.equal(p.parseUrl('https://gitlab.com/g/p/-/merge_requests/3/diffs?tab=x#note_5')?.number, 3);
  // Self-managed host → baseUrl follows the origin.
  assert.equal(
    p.parseUrl('https://gitlab.mycorp.com/team/app/-/merge_requests/1')?.baseUrl,
    'https://gitlab.mycorp.com/api/v4',
  );
});

test('GitLabProvider.parseUrl — rejects non-MR URLs and bare projects', () => {
  const p = new GitLabProvider();
  assert.equal(p.parseUrl('https://gitlab.com/group/proj/-/issues/42'), null);
  assert.equal(p.parseUrl('https://gitlab.com/proj/-/merge_requests/42'), null); // no namespace
  assert.equal(p.parseUrl('https://gitlab.com/group/proj/-/merge_requests/abc'), null);
  assert.equal(p.parseUrl('not a url'), null);
});

test('detectProvider — gitlab.com by hostname; self-managed hosts only via the hosts: allowlist', () => {
  assert.equal(detectProvider('https://gitlab.com/g/p/-/merge_requests/1', {}).name, 'gitlab');
  assert.equal(detectProvider('https://git.mycorp.com/team/app/-/merge_requests/5', { 'git.mycorp.com': 'gitlab' }).name, 'gitlab');
  // No path-shape guessing: an unmapped host is rejected even with a
  // perfectly MR-shaped path — a credential only goes to a host the user named.
  assert.throws(() => detectProvider('https://attacker.example/g/p/-/merge_requests/1', {}), /hosts:/);
});

test('mapDiff — status flags, rename previousPath, +/- counts, empty diff', () => {
  const base = { old_path: 'a.ts', new_path: 'a.ts', new_file: false, deleted_file: false, renamed_file: false };
  const patch = '@@ -1,3 +1,4 @@\n context\n-gone\n+added one\n+added two\n context';
  const modified = mapDiff({ ...base, diff: patch });
  assert.equal(modified.status, 'modified');
  assert.equal(modified.additions, 2);
  assert.equal(modified.deletions, 1);
  assert.equal(modified.patch, patch);
  assert.equal(mapDiff({ ...base, new_file: true, diff: '' }).status, 'added');
  assert.equal(mapDiff({ ...base, deleted_file: true, diff: '' }).status, 'deleted');
  const renamed = mapDiff({ ...base, old_path: 'old.ts', new_path: 'new.ts', renamed_file: true, diff: '' });
  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.previousPath, 'old.ts');
  assert.equal(renamed.patch, undefined, 'empty diff maps to no patch');
});

// The position math that keeps GitLab from rejecting discussions with
// 400 "position is invalid": added lines carry new_line only, context lines
// must also carry the matching old_line.
test('positionForLine — added line has no oldLine, context line has the offset-corrected oldLine', () => {
  // old: 1 ctx / 2 gone / 3 ctx      new: 1 ctx / 2 added / 3 ctx / 4 added2
  const patch = '@@ -1,3 +1,4 @@\n ctx\n-gone\n+added\n ctx\n+added2';
  assert.deepEqual(positionForLine(patch, 2), { newLine: 2 }, 'added line: new_line only');
  assert.deepEqual(positionForLine(patch, 3), { newLine: 3, oldLine: 3 }, 'context line after a -/+ pair keeps both cursors');
  assert.deepEqual(positionForLine(patch, 4), { newLine: 4 }, 'trailing added line');
  assert.equal(positionForLine(patch, 99), null, 'line not in the patch');
});

test('positionForLine — multi-hunk cursors reset per @@ header', () => {
  const patch = '@@ -1,2 +1,2 @@\n ctx\n ctx\n@@ -10,3 +20,4 @@\n ctx\n+new\n ctx\n ctx';
  assert.deepEqual(positionForLine(patch, 20), { newLine: 20, oldLine: 10 });
  assert.deepEqual(positionForLine(patch, 21), { newLine: 21 });
  assert.deepEqual(positionForLine(patch, 22), { newLine: 22, oldLine: 11 });
});

test('classifyAuthor — GitLab bot account patterns', () => {
  assert.equal(classifyAuthor('project_42_bot_a1b2'), 'bot');
  assert.equal(classifyAuthor('group_7_bot'), 'bot');
  assert.equal(classifyAuthor('renovate-bot'), 'bot');
  assert.equal(classifyAuthor('ghost'), 'bot');
  assert.equal(classifyAuthor('copilot-reviewer'), 'copilot');
  assert.equal(classifyAuthor('tifftruong'), 'human');
  assert.equal(classifyAuthor('botanica'), 'human', 'bot must be a word segment, not a prefix of a name');
});

test('isTransientGitLabError — 429/5xx retry, 4xx not', () => {
  const err = (status?: number) => Object.assign(new Error('x'), { status });
  assert.equal(isTransientGitLabError(err(429)), true);
  assert.equal(isTransientGitLabError(err(500)), true);
  assert.equal(isTransientGitLabError(err(503)), true);
  assert.equal(isTransientGitLabError(err(400)), false);
  assert.equal(isTransientGitLabError(err(404)), false);
  assert.equal(isTransientGitLabError(err(undefined)), false);
});

// The slashed-owner bug: without flattening, a nested namespace would mint a
// NESTED run dir; `--detach` returns basename(outDir) as the run-id, so the
// nested dir loses its parent prefix and `status <run-id>` can never resolve
// it — every detached GitLab run would read as missing.
test('safeOwner — slashed namespaces flatten in run dirs and cache paths; github/ado unchanged', () => {
  const ref = new GitLabProvider().parseUrl('https://gitlab.com/group/sub/proj/-/merge_requests/5')!;
  assert.equal(safeOwner(ref), 'group-sub');
  assert.equal(
    gatherCachePath(ref, 'abcdef123456deadbeef', 'none'),
    join(CACHE_ROOT, 'gitlab', 'group-sub__proj', '5', 'abcdef123456-none.json'),
  );
  const outDir = ensureRunDir(ref);
  try {
    const id = basename(outDir);
    assert.ok(id.startsWith('gitlab__group-sub__proj__5__'), `flat run id, got ${id}`);
    assert.equal(basename(dirname(outDir)), 'runs', 'run dir sits directly under runs/ (not nested)');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
  assert.equal(safeOwner({ owner: 'octo' }), 'octo', 'github/ado owners pass through untouched');
});

// URL-decoded components can smuggle backslashes or dot segments; the path
// builders must flatten them so nothing escapes the runs/cache roots.
test('safeSegment — separators and dot segments cannot escape the roots', () => {
  assert.equal(safeSegment('a/../b'), 'a-..-b');
  assert.equal(safeSegment('a\\b'), 'a-b');
  assert.equal(safeSegment('..'), '__');
  assert.equal(safeSegment('.'), '_');
  const evil = { provider: 'gitlab' as const, url: 'x', owner: 'g/../..', repo: '..', number: 1 };
  const p = gatherCachePath(evil, 'abcdef123456deadbeef', 'none');
  assert.ok(p.startsWith(join(CACHE_ROOT, 'gitlab')), `stays under cache root: ${p}`);
  assert.ok(!p.includes(`${join('..', '..')}`), 'no traversal segments in the path');
});

// The `++`/`--` content-line bug: `+++`/`---` are file headers only BEFORE
// content starts. Inside a hunk, an added line whose text begins `++` (diff
// line `+++…`) must advance the NEW cursor, or every later context line in
// the hunk reports a wrong old_line — which GitLab rejects with 400.
test('positionForLine — content lines beginning ++/-- keep the cursors aligned', () => {
  // old: ctx1(1) ctx2(2) ctx3(3) · new: ctx1(1) ++added(2) ctx2(3) ctx3(4)
  const patch = '@@ -1,3 +1,4 @@\n ctx1\n+++added\n ctx2\n ctx3';
  assert.deepEqual(positionForLine(patch, 2), { newLine: 2 }, 'the ++-content added line itself');
  assert.deepEqual(positionForLine(patch, 3), { newLine: 3, oldLine: 2 }, 'context after it: old cursor NOT desynced');
  // Removed markdown rule: old ---(1) ctx(2) · new ctx(1)
  const del = '@@ -1,2 +1,1 @@\n----\n ctx';
  assert.deepEqual(positionForLine(del, 1), { newLine: 1, oldLine: 2 }, 'removed ---- line advances the OLD cursor');
});

test('mapDiff / validLinesFromPatch — ++/-- content lines are counted, ADO-style pre-hunk headers are not', () => {
  const patch = '@@ -1,3 +1,4 @@\n ctx1\n+++added\n---gone\n ctx2';
  const mapped = mapDiff({ old_path: 'a', new_path: 'a', new_file: false, deleted_file: false, renamed_file: false, diff: patch });
  assert.equal(mapped.additions, 1, '+++added counts as one addition');
  assert.equal(mapped.deletions, 1, '---gone counts as one deletion');
  assert.deepEqual([...validLinesFromPatch(patch)].sort((a, b) => a - b), [1, 2, 3], 'the ++ line (new 2) is a valid anchor');
  // ADO synthesized patches carry real file headers before content — still stripped.
  const adoStyle = '--- a/f (abc)\n+++ b/f (def)\n@@ -1,1 +1,2 @@\n ctx\n+new';
  assert.deepEqual([...validLinesFromPatch(adoStyle)].sort((a, b) => a - b), [1, 2]);
});

test('buildDiscussionPosition — typed position: rename old_path, context old_line, descriptive anchoring errors', () => {
  const refs = { base_sha: 'b'.repeat(8), start_sha: 's'.repeat(8), head_sha: 'h'.repeat(8) };
  const renamed = {
    old_path: 'old/name.ts', new_path: 'new/name.ts',
    new_file: false, deleted_file: false, renamed_file: true,
    diff: '@@ -1,2 +1,3 @@\n ctx\n+added\n ctx2',
  };
  // Context line on a renamed file: real old_path AND old_line must both land.
  const ctxPos = buildDiscussionPosition(renamed, { file: 'new/name.ts', line: 3 }, refs);
  assert.equal(ctxPos.old_path, 'old/name.ts', 'rename keeps the REAL old path (wrong old_path 400s)');
  assert.equal(ctxPos.new_path, 'new/name.ts');
  assert.equal(ctxPos.new_line, 3);
  assert.equal(ctxPos.old_line, 2, 'context line carries old_line (missing old_line 400s)');
  // Added line: new_line only.
  const addPos = buildDiscussionPosition(renamed, { file: 'new/name.ts', line: 2 }, refs);
  assert.equal(addPos.old_line, undefined);
  // File not in the MR diffs → descriptive local error, not GitLab's opaque 400.
  assert.throws(() => buildDiscussionPosition(undefined, { file: 'ghost.ts', line: 1 }, refs), /not in the MR diffs/);
  // Line not in the patch → descriptive local error.
  assert.throws(
    () => buildDiscussionPosition(renamed, { file: 'new/name.ts', line: 99 }, refs),
    /line 99 is not in the MR diff/,
  );
  // Collapsed/oversized diff (empty patch): nothing to compute from → new_line-only attempt.
  const collapsed = { ...renamed, renamed_file: false, diff: '' };
  const blind = buildDiscussionPosition(collapsed, { file: 'new/name.ts', line: 7 }, refs);
  assert.equal(blind.new_line, 7);
  assert.equal(blind.old_line, undefined);
});

test('resolveToken — GITLAB_ACCESS_TOKEN fallback, empty-token guard, and host-scoped glab argv', () => {
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fn(); } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
  withEnv({ GITLAB_TOKEN: undefined, GITLAB_ACCESS_TOKEN: 'alt' }, () => {
    assert.equal(resolveToken('gitlab.com'), 'alt', 'GITLAB_ACCESS_TOKEN fallback');
  });
  const calls: string[][] = [];
  const emptyExec = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    return '\n';
  }) as unknown as typeof import('node:child_process').execFileSync;
  withEnv({ GITLAB_TOKEN: undefined, GITLAB_ACCESS_TOKEN: undefined }, () => {
    // glab printing an empty token with exit 0 must THROW — returning ''
    // would inject GITLAB_TOKEN='' into the detached child.
    assert.throws(() => resolveToken('gitlab.mycorp.com', emptyExec), /empty token/);
  });
  assert.deepEqual(calls[0], ['glab', 'config', 'get', 'token', '-h', 'gitlab.mycorp.com'], 'glab asked for the host-scoped token');
});

/** Stub global.fetch for provider round-trip tests (env token set → no subprocess). */
function withFetch(handler: (url: string) => { status?: number; json?: unknown; headers?: Record<string, string> }, fn: () => Promise<void>): Promise<void> {
  const realFetch = global.fetch;
  const prevToken = process.env.GITLAB_TOKEN;
  process.env.GITLAB_TOKEN = 'test-token';
  global.fetch = (async (url: string | URL) => {
    const r = handler(String(url));
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return fn().finally(() => {
    global.fetch = realFetch;
    if (prevToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = prevToken;
  });
}

const MR_URL = 'https://gitlab.com/group/proj/-/merge_requests/7';

test('apiAll — follows x-next-page across pages and concatenates (diffs pagination)', async () => {
  const requested: string[] = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    old_path: `f${i}.ts`, new_path: `f${i}.ts`, new_file: false, deleted_file: false, renamed_file: false, diff: '',
  }));
  const page2 = [{ old_path: 'last.ts', new_path: 'last.ts', new_file: false, deleted_file: false, renamed_file: false, diff: '' }];
  await withFetch(
    (url) => {
      requested.push(url);
      return url.includes('page=2') ? { json: page2 } : { json: page1, headers: { 'x-next-page': '2' } };
    },
    async () => {
      const p = new GitLabProvider();
      const ref = p.parseUrl(MR_URL)!;
      const files = await p.fetchChangedFiles(ref);
      assert.equal(files.length, 101, 'both pages concatenated');
      assert.equal(files[100]!.path, 'last.ts');
      assert.ok(requested.some((u) => u.includes('page=2')), 'second page requested');
    },
  );
});

test('fetchMetadata — state/draft/sha fallbacks survive a closes_issues failure', async () => {
  const mr = {
    iid: 7, title: 'T', description: null, state: 'merged',
    author: { username: 'u' }, source_branch: 's', target_branch: 't',
    labels: [], sha: 'plainsha', diff_refs: null,
    created_at: '2026-01-01', updated_at: '2026-01-02', work_in_progress: true,
  };
  await withFetch(
    (url) => (url.includes('closes_issues') ? { status: 500, json: { message: 'boom' } } : { json: mr }),
    async () => {
      const p = new GitLabProvider();
      const meta = await p.fetchMetadata(p.parseUrl(MR_URL)!);
      assert.equal(meta.state, 'merged');
      assert.equal(meta.isDraft, true, 'legacy work_in_progress alias respected');
      assert.equal(meta.headSha, 'plainsha', 'null diff_refs falls back to mr.sha');
      assert.deepEqual(meta.linkedItems, [], 'closes_issues failure degrades to empty, no throw');
    },
  );
});

test('mapMrMetadata — locked collapses to open', () => {
  const base = {
    iid: 1, title: 'x', description: 'd', state: 'locked' as const,
    source_branch: 's', target_branch: 't', labels: ['l'], sha: 'sha',
    created_at: 'c', updated_at: 'u',
  };
  assert.equal(mapMrMetadata(base, []).state, 'open');
  assert.equal(mapMrMetadata({ ...base, state: 'closed' }, []).state, 'closed');
  assert.equal(mapMrMetadata({ ...base, state: 'opened' }, []).isDraft, false);
});

test('fetchExistingComments — drops system notes; mapNote resolves file/line from either diff side', async () => {
  const notes = [
    { id: 1, body: 'changed the description', system: true, author: { username: 'u' }, created_at: 'c' },
    { id: 2, body: 'human note', system: false, author: { username: 'human' }, created_at: 'c', position: { new_path: 'a.ts', new_line: 5 } },
    { id: 3, body: 'old-side note', system: false, author: { username: 'project_9_bot_x' }, created_at: 'c', position: { old_path: 'b.ts', old_line: 3 } },
  ];
  await withFetch(
    () => ({ json: notes }),
    async () => {
      const p = new GitLabProvider();
      const out = await p.fetchExistingComments(p.parseUrl(MR_URL)!);
      assert.equal(out.length, 2, 'system note dropped');
      assert.deepEqual({ file: out[0]!.file, line: out[0]!.line }, { file: 'a.ts', line: 5 });
      assert.deepEqual({ file: out[1]!.file, line: out[1]!.line, source: out[1]!.source }, { file: 'b.ts', line: 3, source: 'bot' });
    },
  );
});

test('mapNote — position fallbacks', () => {
  const n = { id: 9, body: 'b', system: false, author: { username: 'u' }, created_at: 'c' };
  assert.equal(mapNote(n).file, undefined, 'no position → no file');
  assert.equal(mapNote({ ...n, position: { new_path: 'x', old_path: 'y', new_line: 1, old_line: 2 } }).line, 1, 'new side wins');
});

test('mapMrMetadata — changes_count: a number is exact, "N+" means the stored diff is truncated, empty is unknown', () => {
  const base = {
    iid: 1, title: 'x', description: 'd', state: 'opened' as const,
    source_branch: 's', target_branch: 't', labels: [], sha: 'sha', created_at: 'c', updated_at: 'u',
  };
  const exact = mapMrMetadata({ ...base, changes_count: '42' }, []);
  assert.equal(exact.changedFileCount, 42);
  assert.equal(exact.changedFileListTruncated, false);
  // "N+" is the overflow flag: /diffs pages over the STORED diff, which is exactly the capped set, so
  // for "N+" the list has exactly N entries and a length comparison could never detect the cut.
  // Overflow also triggers on lines/bytes, so "37+" is as real as "1000+".
  for (const raw of ['1000+', '37+']) {
    const capped = mapMrMetadata({ ...base, changes_count: raw }, []);
    assert.equal(capped.changedFileCount, Number.parseInt(raw, 10), raw);
    assert.equal(capped.changedFileListTruncated, true, raw);
  }
  for (const raw of ['', undefined, null]) {
    const unknown = mapMrMetadata({ ...base, changes_count: raw as string }, []);
    assert.equal(unknown.changedFileCount, undefined, `unknown for ${String(raw)}`);
    assert.equal(unknown.changedFileListTruncated, undefined, `unknown for ${String(raw)}`);
  }
});
