import { execFileSync, spawn, type ChildProcess, type ChildProcessByStdio, type StdioOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldPath } from './realpath.js';
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

// Absolute on win32: a bare name is searched in the cwd before PATH, and the
// cwd is often the checkout of the PR under review — branch-authored files.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * Kill `pid` and, on win32, every descendant (`taskkill /T /F`). POSIX sends
 * SIGKILL to the one process: nothing there runs a shell in front of the
 * runtime (`spawnCli` spawns it directly), so the pid IS the runtime.
 * Returns whether it is gone — a refusal (access denied, a protected
 * descendant) must not read as a kill.
 */
function killPidTree(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      execFileSync(join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // Judged below by liveness: the error text does not distinguish "already gone" from "refused".
  }
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 20 && pidAlive(pid); i++) Atomics.wait(wait, 0, 0, 100);
  return !pidAlive(pid);
}

/**
 * INV-HYG-04. On win32 `spawnCli` runs the CLI behind `cmd.exe`, so
 * `child.kill()` ends the shell and leaves the runtime session running with
 * nobody reading it. Kill the whole tree.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null) killPidTree(child.pid);
}

const liveChildren = new Set<ChildProcess>();
let exitHooked = false;

/**
 * Kill `child`'s tree if this process exits first — a thrown error or a
 * `process.exit()` mid-dispatch. A hard kill of this process runs no handler;
 * `reapOrphanRuntime` covers that from the next `status` or `--resume`.
 */
export function killOnExit(child: ChildProcess): void {
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => liveChildren.forEach(killTree));
  }
  liveChildren.add(child);
  child.once('close', () => liveChildren.delete(child));
}

/** Every process as `{ pid, cmd }`, or null when the process table cannot be read. */
function processTable(): { pid: number; cmd: string }[] | null {
  const [file, args] = process.platform === 'win32'
    ? [join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }']]
    : ['ps', ['-eo', 'pid=,args=']];
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
    // win32 rows are `pid<TAB>cmd`; `ps` pads the pid column with spaces.
    return out.split(/\r?\n/).flatMap((line) => {
      const m = /^\s*(\d+)[\t ](.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), cmd: m[2]! }] : [];
    });
  } catch {
    return null;
  }
}

/**
 * The argv shape every runtime this CLI spawns carries its run dir in:
 * `--add-dir <runDir>` (claude, copilot — `runtimeSpawnArgs`) or `-C <runDir>`
 * (codex — `runCodexReviewer`), each argument quoted on win32 by `spawnCli`.
 * The flag is the identity: an editor that opened the run dir, and this CLI
 * itself (`--run-dir <runDir>`), name the same path.
 *
 * Both sides go through `foldPath`, which lowercases — so the Codex flag is
 * written `-c` here, and it matches `-C` on every platform.
 */
export function namesRunDir(cmd: string, outDir: string): boolean {
  const dir = foldPath(outDir).replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"])(?:--add-dir|-c)"?\\s+"?${dir}/?(?:"|\\s|$)`).test(foldPath(cmd));
}

export interface ReapResult {
  /** Pids whose argv named the run dir and are now gone. */
  killed: number[];
  /** Pids whose argv named the run dir and survived the kill. */
  survived: number[];
  /** The process table could not be read — nothing is known, nothing was done. */
  scanFailed: boolean;
}

/**
 * INV-HYG-04. Kill the runtime sessions of a run whose process died without
 * killing them — a hard kill runs no exit handler. Acts only when the run's
 * `run.pid` exists and is dead, and only on processes whose argv hands them
 * this run dir (`namesRunDir`). Matched by argv rather than by a recorded pid:
 * on win32 the recorded pid would be the `cmd.exe` in front of the runtime,
 * which dies with the CLI and leaves the runtime unreachable through it.
 */
export function reapOrphanRuntime(outDir: string): ReapResult {
  const none: ReapResult = { killed: [], survived: [], scanFailed: false };
  let runPid = 0;
  try {
    runPid = Number(readFileSync(join(outDir, 'run.pid'), 'utf8').trim());
  } catch {
    // No run.pid means no owner to judge: never kill on a missing beacon.
  }
  if (!(runPid > 0) || pidAlive(runPid)) return none;
  const table = processTable();
  if (!table) return { ...none, scanFailed: true };
  const result = { ...none, killed: [] as number[], survived: [] as number[] };
  for (const p of table) {
    if (p.pid === process.pid || !namesRunDir(p.cmd, outDir)) continue;
    (killPidTree(p.pid) ? result.killed : result.survived).push(p.pid);
  }
  return result;
}

/** The one line both callers record, or null when there is nothing to say. */
export function describeReap(r: ReapResult): string | null {
  if (r.scanFailed) return 'run process died — could not read the process table to look for its orphaned runtime session';
  const parts = [
    r.killed.length ? `killed its orphaned runtime session (pid ${r.killed.join(', ')})` : '',
    r.survived.length ? `could NOT kill orphaned runtime pid ${r.survived.join(', ')} — end it manually` : '',
  ].filter(Boolean);
  return parts.length ? `run process died — ${parts.join('; ')}` : null;
}
