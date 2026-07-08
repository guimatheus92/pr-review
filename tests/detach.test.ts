import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { detachReview } from '../src/commands/detach.js';

test('detachReview — strips --detach, appends --run-dir, spawns detached+unref with an error listener', () => {
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
    assert.ok(child.unrefed, 'child.unref() called so the parent can exit');
    assert.ok(child.events.includes('error'), 'spawn-error listener attached');
    assert.ok(runId.length > 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
