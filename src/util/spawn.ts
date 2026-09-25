import { execFileSync, spawn, type ChildProcess, type ChildProcessByStdio, type StdioOptions } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

interface SpawnCliOptions {
  stdio: StdioOptions;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// shell:true is required on win32 to launch npm .cmd shims (claude/copilot/codex);
// constrain the interpolated values so nothing shell-significant can ride along.
export const SAFE_ARG_RE = /^[\p{L}\p{N}\p{M}_.\-:+\\\/ ~()=,*]+$/u;

export function assertSafeArg(name: string, value: string): void {
  if (!SAFE_ARG_RE.test(value)) {
    throw new Error(`[spawn] refusing to spawn: ${name} contains unsupported characters: ${value}`);
  }
}

/**
 * DEP0190-safe CLI spawn. win32 still needs a shell for the .cmd shims, but an
 * args ARRAY with shell:true concatenates unescaped (Node DEP0190) — so build
 * the command line ourselves from SAFE_ARG_RE-validated, individually
 * double-quoted parts (the regex forbids `"` and every cmd metacharacter, so
 * quoting is sound). Other platforms spawn the binary directly — no shell.
 */
export function spawnCli(binary: string, argv: string[], opts: SpawnCliOptions & { stdio: ['pipe', 'pipe', 'pipe'] }): ChildProcessByStdio<Writable, Readable, Readable>;
export function spawnCli(binary: string, argv: string[], opts: SpawnCliOptions & { stdio: ['pipe', 'ignore', 'pipe'] }): ChildProcessByStdio<Writable, null, Readable>;
export function spawnCli(binary: string, argv: string[], opts: SpawnCliOptions): ChildProcess {
  if (process.platform === 'win32') {
    for (const part of [binary, ...argv]) assertSafeArg('argument', part);
    return spawn(
      [binary, ...argv].map((part) => `"${part}"`).join(' '),
      { stdio: opts.stdio, cwd: opts.cwd, env: opts.env, windowsHide: true, shell: true },
    );
  }
  return spawn(binary, argv, { stdio: opts.stdio, cwd: opts.cwd, env: opts.env, windowsHide: true });
}

/** True if a process with this pid is alive. EPERM (exists, not ours) counts as alive. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function killPidTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // best-effort: already gone
  }
}

/**
 * INV-HYG-04. On win32 `spawnCli` runs the CLI behind `cmd.exe`, so
 * `child.kill()` ends the shell and leaves the runtime session running with
 * nobody reading it. Kill the whole tree. Elsewhere there is no shell in
 * between, so the child is the runtime itself.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null) killPidTree(child.pid);
}

const liveChildren = new Set<ChildProcess>();

/**
 * Kill `child`'s tree if this process exits first — a thrown error or a
 * `process.exit()` mid-dispatch. A hard kill of this process runs no handler;
 * `reapOrphanRuntime` covers that from the next `status` or `--resume`.
 */
export function killOnExit(child: ChildProcess): void {
  if (liveChildren.size === 0) process.once('exit', () => liveChildren.forEach(killTree));
  liveChildren.add(child);
  child.once('close', () => liveChildren.delete(child));
}

/** Run-dir file holding the pid `spawnCli` returned for the runtime session. */
export const RUNTIME_PID_FILE = 'runtime.pid';

function commandLine(pid: number): string | null {
  const [file, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`]]
    : ['ps', ['-o', 'command=', '-p', String(pid)]];
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 15_000 });
  } catch {
    return null;
  }
}

const fold = (s: string) => (process.platform === 'win32' ? s.replace(/\//g, '\\').toLowerCase() : s);

/**
 * INV-HYG-04. Kill a runtime session whose run process died without killing
 * it (a hard kill runs no exit handler). Acts only when all three hold: the
 * run's `run.pid` exists and is dead, the recorded runtime pid is alive, and that pid's
 * command line names this run dir — the runtime is always spawned with it, so
 * a pid the OS has since reused for something else is left alone.
 * Returns true when it killed something.
 */
export function reapOrphanRuntime(outDir: string): boolean {
  const read = (f: string) => {
    try {
      return Number(readFileSync(join(outDir, f), 'utf8').trim());
    } catch {
      return 0;
    }
  };
  const runPid = read('run.pid');
  const runtimePid = read(RUNTIME_PID_FILE);
  // No run.pid means no owner to judge: never kill on a missing beacon.
  if (!(runPid > 0) || pidAlive(runPid) || !(runtimePid > 0) || !pidAlive(runtimePid)) return false;
  const cmd = commandLine(runtimePid);
  if (!cmd || !fold(cmd).includes(fold(outDir))) return false;
  killPidTree(runtimePid);
  rmSync(join(outDir, RUNTIME_PID_FILE), { force: true });
  return true;
}
