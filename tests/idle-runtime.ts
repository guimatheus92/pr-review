// Shared by the INV-HYG-04 tests: a long-lived node process launched through
// spawnCli exactly like a runtime, plus the pollers that judge whether it died.
import { after } from 'node:test';
import type { ChildProcessByStdio } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pidAlive, spawnCli } from '../src/util/spawn.js';

/**
 * A pid no process has — `process.kill(pid, 0)` answers ESRCH. Not a process
 * that just exited: the OS may hand that pid to someone else mid-test.
 */
export const DEAD_PID = 2147483646;

/** Named, not `ReturnType<typeof spawnCli>`: that resolves to the LAST overload, whose stdout is null. */
export interface IdleRuntime {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  pid: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every idle runtime started by a test file, for the `after` sweep below. */
const started: IdleRuntime[] = [];

// A kill under test that regresses leaves a survivor whose stdout/stderr pipes
// keep this process's event loop referenced, so `node --test` would hang on it
// instead of failing: kill it by pid, and destroy the pipes. The exit-code
// guard is best effort — on win32 `child` is the cmd.exe in front of the pid,
// whose exit says nothing about the pid — and the catch covers the race.
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
export async function idleRuntime(root: string, extraArgs: string[]): Promise<IdleRuntime> {
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
