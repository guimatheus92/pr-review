import { execFileSync, spawn, type ChildProcess, type ChildProcessByStdio, type StdioOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

/** `pid<TAB>command line` for every process, or null when the table cannot be read. */
function processTable(): { pid: number; cmd: string }[] | null {
  const [file, args] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }']]
    : ['ps', ['-eo', 'pid=,args=']];
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
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
 * `--add-dir <runDir>` (claude, copilot) or `-C <runDir>` (codex), quoted on
 * win32 by `spawnCli`. An editor that merely opened a file in the run dir
 * names it too, so the flag is part of the identity.
 */
export function namesRunDir(cmd: string, outDir: string): boolean {
  const win = process.platform === 'win32';
  const fold = (s: string) => (win ? s.replace(/\//g, '\\').toLowerCase() : s);
  const dir = fold(outDir).replace(/[\\/]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s"])(?:--add-dir|${win ? '-c' : '-C'})"?\\s+"?${dir}[\\\\/]?(?:"|\\s|$)`).test(fold(cmd));
}

/**
 * INV-HYG-04. Kill the runtime sessions of a run whose process died without
 * killing them — a hard kill runs no exit handler. Acts only when the run's
 * `run.pid` exists and is dead, and only on processes whose argv hands them
 * this run dir (`namesRunDir`). Matched by argv rather than by a recorded pid:
 * on win32 the recorded pid would be the `cmd.exe` in front of the runtime,
 * which can die first and leave the runtime unreachable through it.
 * Returns true when it killed something.
 */
export function reapOrphanRuntime(outDir: string): boolean {
  let runPid = 0;
  try {
    runPid = Number(readFileSync(join(outDir, 'run.pid'), 'utf8').trim());
  } catch {
    // No run.pid means no owner to judge: never kill on a missing beacon.
  }
  if (!(runPid > 0) || pidAlive(runPid)) return false;
  const orphans = (processTable() ?? []).filter((p) => p.pid !== process.pid && namesRunDir(p.cmd, outDir));
  for (const p of orphans) killPidTree(p.pid);
  return orphans.length > 0;
}
