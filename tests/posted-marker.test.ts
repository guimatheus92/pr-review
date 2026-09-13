import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPostedMarker, writePostedMarker } from '../src/util/posted-marker.js';
import { controlDirForRun } from '../src/util/tmp.js';
import { createDispatchPlan, writeDispatchPlan } from '../src/dispatch/delivery.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'pr-marker-'));
}

test('readPostedMarker — absent → null (safe to post)', () => {
  const d = tmp();
  try {
    assert.equal(readPostedMarker(d, d), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — round-trips a well-formed marker', () => {
  const d = tmp();
  try {
    writePostedMarker(d, { posted: 5, attempted: 5 }, d);
    const m = readPostedMarker(d, d);
    assert.notEqual(m, null);
    assert.notEqual(m, 'corrupt');
    assert.equal((m as { posted: number }).posted, 5);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — carries the verified flag; an old marker without one reads as verified', () => {
  const d = tmp();
  try {
    writePostedMarker(d, { posted: 0, attempted: 3, verified: false }, d);
    assert.equal((readPostedMarker(d, d) as { verified?: boolean }).verified, false);
    // Markers written before 0.6.1 have no flag — absent must not read as
    // unverified, or every pre-existing run dir would lock its own resume out.
    writeFileSync(join(d, 'posted.marker'), '{"postedAt":1,"posted":2,"attempted":2}', 'utf8');
    assert.equal((readPostedMarker(d, d) as { verified?: boolean }).verified, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — unparseable or misshapen → "corrupt" (fail-closed signal, not "absent")', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'posted.marker'), '{ not json', 'utf8');
    assert.equal(readPostedMarker(d, d), 'corrupt');
    writeFileSync(join(d, 'posted.marker'), '{"postedAt":1}', 'utf8'); // missing posted/attempted
    assert.equal(readPostedMarker(d, d), 'corrupt');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// 0.15.0 hardened `markerShaped` from two typeof checks into a full shape contract,
// and shipped it with no test. The function is private, so this grades it through
// `readPostedMarker`, whose 'corrupt' return IS the observable behaviour — a marker
// that fails the shape must fail closed, never read as 'nothing was posted', which
// is the inference that reposts a whole review (INV-POST-04).
test('readPostedMarker — every hardened shape rule fails closed, not open', () => {
  const d = tmp();
  try {
    const reject: Array<[string, Record<string, unknown>]> = [
      ['posted is not an integer', { posted: 1.5, attempted: 2 }],
      ['posted is negative', { posted: -1, attempted: 2 }],
      ['attempted is below posted', { posted: 5, attempted: 4 }],
      ['verified is not a boolean', { posted: 1, attempted: 1, verified: 'yes' }],
      ['planFingerprint is not a string', { posted: 1, attempted: 1, planFingerprint: 7 }],
      ['confirmedKeys is not an array', { posted: 1, attempted: 1, confirmedKeys: 'a' }],
      ['confirmedKeys holds a non-string', { posted: 1, attempted: 1, confirmedKeys: [1] }],
      ['confirmedKeys count disagrees with posted', { posted: 2, attempted: 2, confirmedKeys: ['a'] }],
    ];
    for (const [why, marker] of reject) {
      writeFileSync(join(d, 'posted.marker'), JSON.stringify(marker), 'utf8');
      assert.equal(readPostedMarker(d, d), 'corrupt', why);
    }

    // The mirror image: a marker that satisfies every rule must still round-trip,
    // or the hardening would read every real marker as corrupt and block resume.
    const accept: Record<string, unknown> = {
      posted: 2, attempted: 3, verified: true, planFingerprint: 'abc', confirmedKeys: ['k1', 'k2'],
    };
    writeFileSync(join(d, 'posted.marker'), JSON.stringify(accept), 'utf8');
    const read = readPostedMarker(d, d);
    assert.notEqual(read, 'corrupt');
    assert.notEqual(read, null);
    assert.deepEqual((read as { confirmedKeys?: string[] }).confirmedKeys, ['k1', 'k2']);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — schema-v1 authority wins over a forged diagnostic mirror', () => {
  const d = tmp();
  try {
    const controlDir = controlDirForRun(d, d);
    const plan = createDispatchPlan({
      runId: 'run', runDir: d, createdAt: new Date(0).toISOString(),
      pr: { provider: 'github', url: 'u', owner: 'o', repo: 'r', number: 1 },
      metadata: { headSha: 'h', baseSha: 'b', headBranch: 'f', baseBranch: 'main', state: 'open', isDraft: false },
      runtime: 'copilot', runtimeBinary: 'copilot', disabledMcpServers: [], model: 'm', timeoutMs: 1,
      phase1Path: join(d, 'phase1-findings.json'), findingsPath: join(d, 'single-session-findings.json'),
      execution: { dryRun: false, publish: true, dedupeMode: 'strict' },
      configProjection: {}, configFingerprint: 'f', artifacts: [], reviewers: [],
      verifier: { enabled: false, maxAttempts: 3 },
      codex: { enabled: false, contextPath: join(d, 'pr-context.md'), attemptsDir: join(d, 'codex-attempts'), maxAttempts: 3 },
    });
    writeDispatchPlan(plan, join(d, 'dispatch-plan.json'), join(controlDir, 'dispatch-plan.json'));
    writePostedMarker(d, { posted: 1, attempted: 1, verified: true }, d);
    writeFileSync(join(d, 'posted.marker'), JSON.stringify({ posted: 0, attempted: 1, verified: true }), 'utf8');
    const marker = readPostedMarker(d, d);
    assert.notEqual(marker, 'corrupt');
    assert.equal((marker as { posted: number }).posted, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — reads authenticated Windows backup authority without mutating it', () => {
  const d = tmp();
  try {
    const controlDir = controlDirForRun(d, d);
    const plan = createDispatchPlan({
      runId: 'run', runDir: d, createdAt: new Date(0).toISOString(),
      pr: { provider: 'github', url: 'u', owner: 'o', repo: 'r', number: 1 },
      metadata: { headSha: 'h', baseSha: 'b', headBranch: 'f', baseBranch: 'main', state: 'open', isDraft: false },
      runtime: 'copilot', runtimeBinary: 'copilot', disabledMcpServers: [], model: 'm', timeoutMs: 1,
      phase1Path: join(d, 'phase1-findings.json'), findingsPath: join(d, 'single-session-findings.json'),
      execution: { dryRun: false, publish: true, dedupeMode: 'strict' },
      configProjection: {}, configFingerprint: 'f', artifacts: [], reviewers: [],
      verifier: { enabled: false, maxAttempts: 2 },
      codex: { enabled: false, contextPath: join(d, 'pr-context.md'), attemptsDir: join(d, 'codex-attempts'), maxAttempts: 2 },
    });
    writeDispatchPlan(plan, join(d, 'dispatch-plan.json'), join(controlDir, 'dispatch-plan.json'));
    writePostedMarker(d, { posted: 1, attempted: 1, verified: true }, d);
    const authority = join(controlDir, 'posted.marker');
    const backup = join(controlDir, '.posted.marker.bak');
    renameSync(authority, backup);
    const marker = readPostedMarker(d, d);
    assert.notEqual(marker, 'corrupt');
    assert.equal((marker as { posted: number }).posted, 1);
    assert.equal(existsSync(authority), false);
    assert.equal(existsSync(backup), true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — schema-v1 forged mirror without authority cannot suppress posting', () => {
  const d = tmp();
  try {
    const controlDir = controlDirForRun(d, d);
    const plan = createDispatchPlan({
      runId: 'run', runDir: d, createdAt: new Date(0).toISOString(),
      pr: { provider: 'github', url: 'u', owner: 'o', repo: 'r', number: 1 },
      metadata: { headSha: 'h', baseSha: 'b', headBranch: 'f', baseBranch: 'main', state: 'open', isDraft: false },
      runtime: 'copilot', runtimeBinary: 'copilot', disabledMcpServers: [], model: 'm', timeoutMs: 1,
      phase1Path: join(d, 'phase1-findings.json'), findingsPath: join(d, 'single-session-findings.json'),
      execution: { dryRun: false, publish: true, dedupeMode: 'strict' },
      configProjection: {}, configFingerprint: 'f', artifacts: [], reviewers: [],
      verifier: { enabled: false, maxAttempts: 3 },
      codex: { enabled: false, contextPath: join(d, 'pr-context.md'), attemptsDir: join(d, 'codex-attempts'), maxAttempts: 3 },
    });
    writeDispatchPlan(plan, join(d, 'dispatch-plan.json'), join(controlDir, 'dispatch-plan.json'));
    writeFileSync(join(d, 'posted.marker'), JSON.stringify({ posted: 1, attempted: 1, verified: true }), 'utf8');
    assert.equal(readPostedMarker(d, d), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
