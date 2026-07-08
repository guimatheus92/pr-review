import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview } from '../src/commands/review.js';
import { writePostedMarker } from '../src/util/posted-marker.js';
import type { Finding, PrRef } from '../src/types.js';
import type { BatchComment, PrProvider } from '../src/providers/types.js';

const PATCH = ['@@ -10,4 +10,5 @@', ' c10', '-old11', '+new11', '+new12', ' c13'].join('\n');

function gatherFixture() {
  return {
    pr: { provider: 'github' as const, url: 'u', owner: 'o', repo: 'r', number: 1 },
    metadata: {
      title: 't', description: 'a real description of the change', author: 'a',
      headSha: 'sha1234567890', baseSha: 'sha0', baseBranch: 'main', headBranch: 'f',
      labels: [], linkedItems: [], createdAt: '', updatedAt: '', isDraft: false, state: 'open' as const,
    },
    changedFiles: [{ path: 'src/a.ts', status: 'modified' as const, additions: 2, deletions: 1, patch: PATCH }],
    fullDiff: '', existingComments: [], gatheredAt: '',
  };
}

function fakeProvider() {
  const calls = { batches: [] as BatchComment[][], singles: [] as Finding[] };
  const provider: PrProvider = {
    name: 'github',
    parseUrl: (url: string): PrRef => ({ provider: 'github', url, owner: 'o', repo: 'r', number: 1 }),
    fetchMetadata: async () => gatherFixture().metadata,
    fetchChangedFiles: async () => [],
    fetchFullDiff: async () => '',
    fetchExistingComments: async () => [],
    postLineComment: async (_ref, f) => {
      if (!f.file || !f.line) return null;
      calls.singles.push(f);
      return { id: 'x' };
    },
    postBatchComments: async (_ref, _sha, comments) => {
      calls.batches.push(comments);
      return { posted: comments.length };
    },
  };
  return { provider, calls };
}

/** Seed a run dir with the two on-disk artifacts resume needs. */
function seedRun(reviewers: Array<{ name: string; findings: Finding[] }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-'));
  writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
  writeFileSync(join(dir, 'single-session-findings.json'), JSON.stringify({ reviewers }), 'utf8');
  return dir;
}

const ONE: Array<{ name: string; findings: Finding[] }> = [
  { name: 'security', findings: [{ severity: 'HIGH', title: 'x', body: 'a real finding body', file: 'src/a.ts', line: 11 }] },
];

test('resume — reuses on-disk reviewer outputs, posts them, and writes posted.marker (no session spawn)', async () => {
  const dir = seedRun(ONE);
  try {
    const { provider, calls } = fakeProvider();
    const r = await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.equal(calls.batches.length, 1, 'posted via one batch');
    assert.equal(calls.batches[0].length, 1);
    assert.ok(existsSync(join(dir, 'posted.marker')), 'marker written after a successful post');
    assert.match(r.summary, /PR Review Summary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a second resume refuses to re-post while the marker exists; --force-post overrides', async () => {
  const dir = seedRun(ONE);
  try {
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: fakeProvider().provider });

    const second = fakeProvider();
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: second.provider });
    assert.equal(second.calls.batches.length, 0, 'posted.marker present → no duplicate post');

    const third = fakeProvider();
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, forcePost: true, provider: third.provider });
    assert.equal(third.calls.batches.length, 1, '--force-post overrides the marker');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — falls back to phase1-findings.json when the final consolidation file is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-'));
  try {
    writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
    writeFileSync(join(dir, 'phase1-findings.json'), JSON.stringify({ reviewers: ONE }), 'utf8');
    const { provider, calls } = fakeProvider();
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider });
    assert.equal(calls.batches.length, 1, 'salvaged findings from phase1 and posted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a corrupt posted.marker fails closed (no re-post) unless --force-post', async () => {
  const dir = seedRun(ONE);
  try {
    writeFileSync(join(dir, 'posted.marker'), '{ corrupt not json', 'utf8');
    const a = fakeProvider();
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: a.provider });
    assert.equal(a.calls.batches.length, 0, 'corrupt marker → refuse (fail closed)');
    const b = fakeProvider();
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, forcePost: true, provider: b.provider });
    assert.equal(b.calls.batches.length, 1, '--force-post overrides');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — a partial prior post (posted < attempted) is retried, not skipped', async () => {
  const dir = seedRun(ONE);
  try {
    writePostedMarker(dir, { posted: 1, attempted: 3 }); // a partial post left findings unposted
    const a = fakeProvider();
    await runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: a.provider });
    assert.equal(a.calls.batches.length, 1, 'partial marker must not strand the un-posted findings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume — missing gather and missing reviewer output each error clearly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-resume-'));
  try {
    await assert.rejects(
      runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: fakeProvider().provider }),
      /no pr-review-gather/,
    );
    writeFileSync(join(dir, 'pr-review-gather.json'), JSON.stringify(gatherFixture()), 'utf8');
    await assert.rejects(
      runReview({ prUrl: 'u', resumeRunId: 'x', runDir: dir, publish: true, provider: fakeProvider().provider }),
      /nothing to resume/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
