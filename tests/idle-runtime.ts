// Shared by the INV-HYG-04 tests: a long-lived node process launched through
// spawnCli exactly like a runtime, plus the pollers that judge whether it died.
import { after } from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pidAlive, spawnCli } from '../src/util/spawn.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every idle runtime started by a test file, for the `after` sweep below. */
const started: { child: ReturnType<typeof spawnCli>; pid: number }[] = [];

// A kill under test that regresses leaves a survivor holding the file open
// forever; kill it by pid so the regression FAILS instead of hanging. Only
// while `child` has not exited — a pid the tree kill already reaped may since
// belong to someone else.
after(() => {
  for (const s of started) {
    try {
      if (pidAlive(s.pid) && s.child.exitCode === null) process.kill(s.pid);
    } catch {
      // gone between the check and the kill
    }
    s.child.stdout.destroy();
    s.child.stderr.destroy();
  }
});

/** Start an idle node process with `extraArgs` in its argv; resolves once it has written its own pid. */
export async function idleRuntime(root: string, extraArgs: string[]): Promise<{ child: ReturnType<typeof spawnCli>; pid: number }> {
  const script = join(root, 'idle.js');
  const pidFile = join(root, `idle-${process.hrtime.bigint()}.pid`);
  // Write-then-rename so a reader never sees an empty or partial pid.
  writeFileSync(
    script,
    "const fs = require('fs'); fs.writeFileSync(process.argv[2] + '.tmp', String(process.pid)); fs.renameSync(process.argv[2] + '.tmp', process.argv[2]); setInterval(() => {}, 1000);",
    'utf8',
  );
  const child = spawnCli(process.execPath, [script, pidFile, ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  for (let i = 0; i < 100; i++) {
    let pid = 0;
    try {
      pid = Number(readFileSync(pidFile, 'utf8'));
    } catch {
      // not written yet
    }
    if (pid > 0) {
      started.push({ child, pid });
      return { child, pid };
    }
    await sleep(50);
  }
  throw new Error('idle runtime never started');
}

/** True once `pid` is dead, polling up to 3 s. */
export async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

/** A pid that is certainly dead: a process that already exited. */
export async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise((r) => c.on('close', r));
  return c.pid!;
}
