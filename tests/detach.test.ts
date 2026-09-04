import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detachReview } from '../src/commands/detach.js';
import { RUNS_ROOT } from '../src/util/tmp.js';

test('detachReview — strips --detach, appends --run-dir, spawns detached+unref with an error listener and pre-resolved auth env', () => {
  // Pre-set the token so the parent pre-flight resolves from env (no `gh` subprocess).
  const prevToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.PR_REVIEW_TEST_CANARY = 'canary';
  const calls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const child = {
    events: [] as string[],
    unrefed: false,
    on(ev: string) {
      this.events.push(ev);
      return this;
    },
    unref() {
      this.unrefed = true;
    },
  };
  const fakeSpawn = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const url = 'https://github.com/o/r/pull/7';
  const { runId, outDir } = detachReview(url, ['review', url, '--dry-run', '--detach'], fakeSpawn);
  try {
    assert.equal(calls.length, 1);
    const { args, opts } = calls[0]!;
    assert.ok(!args.includes('--detach'), '--detach stripped from child argv');
    assert.ok(args.includes('--dry-run'), 'user flags preserved');
    assert.deepEqual(args.slice(-2), ['--run-dir', outDir], 'run-dir appended, shared with parent');
    assert.equal(opts.detached, true);
    assert.equal(opts.windowsHide, true);
    const env = opts.env as NodeJS.ProcessEnv;
    assert.equal(env.GITHUB_TOKEN, 'test-token', 'auth resolved in the parent and injected into the child env');
    assert.equal(env.PR_REVIEW_TEST_CANARY, 'canary', 'parent env still spread into the child');
    assert.ok(child.unrefed, 'child.unref() called so the parent can exit');
    assert.ok(child.events.includes('error'), 'spawn-error listener attached');
    assert.ok(runId.length > 0);
  } finally {
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevToken;
    delete process.env.PR_REVIEW_TEST_CANARY;
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('detachReview — a failed auth pre-flight throws before spawning anything', () => {
  let spawns = 0;
  const fakeSpawn = (() => {
    spawns++;
    return { on() { return this; }, unref() {} };
  }) as unknown as typeof import('node:child_process').spawn;

  const url = 'https://github.com/o/r/pull/7';
  assert.throws(
    () =>
      detachReview(url, ['review', url, '--detach'], fakeSpawn, () => {
        throw new Error('No GitHub auth token available.');
      }),
    /No GitHub auth token/,
  );
  assert.equal(spawns, 0, 'no detached child after a failed pre-flight');
});

test('detachReview — an unparsable PR URL throws in the foreground, before auth and before spawn', () => {
  let spawns = 0;
  let authCalls = 0;
  const fakeSpawn = (() => {
    spawns++;
    return { on() { return this; }, unref() {} };
  }) as unknown as typeof import('node:child_process').spawn;

  // Detection accepts the visualstudio.com host, but the extra path segments
  // fail the ADO parse — the detection-accepted-then-parse-rejected shape of
  // the field incident. Before the fail-fast reorder this minted an adhoc run
  // dir and died inside the detached child (status exit 22).
  const url = 'https://contoso.visualstudio.com/a/b/c/_git/r/pullrequest/1';
  assert.throws(
    () =>
      detachReview(url, ['review', url, '--detach'], fakeSpawn, () => {
        authCalls++;
        return {};
      }),
    /Failed to parse PR URL/,
  );
  assert.equal(spawns, 0, 'no detached child for a bad URL');
  assert.equal(authCalls, 0, 'URL validation precedes the auth pre-flight');
});

test('detachReview — self-hosted provider comes from trusted config, not a branch host remap', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-detach-trusted-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-detach-trusted-home-'));
  const previous = process.cwd();
  const calls: Array<{ args: string[] }> = [];
  const child = { on() { return this; }, unref() {} };
  const fakeSpawn = ((_cmd: string, args: string[]) => {
    calls.push({ args });
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  const url = 'https://github.corp.example/o/r/pull/7';
  // ensureRunDir mints under the REAL home (RUNS_ROOT ignores homeOverride), so
  // sweep whatever this test created there — on the throw path too.
  const runsBefore = new Set(existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : []);
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'hosts:\n  github.corp.example: github\n');
    writeFileSync(join(cwd, '.pr-review.yaml'), 'hosts:\n  github.corp.example: gitlab\n');
    process.chdir(cwd);

    const result = detachReview(url, ['review', url, '--detach'], fakeSpawn, () => ({}), home);
    assert.match(result.runId, /^github__o__r__7__/, 'trusted GitHub mapping owns the run identity');
    assert.equal(calls.length, 1, 'the trusted mapping reaches child spawn');
    assert.deepEqual(calls[0]!.args.slice(-2), ['--run-dir', result.outDir], 'the child inherits the run dir minted from the trusted mapping');
  } finally {
    process.chdir(previous);
    for (const entry of existsSync(RUNS_ROOT) ? readdirSync(RUNS_ROOT) : []) {
      if (!runsBefore.has(entry) && entry.startsWith('github__o__r__7__')) rmSync(join(RUNS_ROOT, entry), { recursive: true, force: true });
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
