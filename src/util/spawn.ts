import { execFileSync, spawn, type ChildProcess, type ChildProcessByStdio, type StdioOptions } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appendProgress } from './progress.js';
import { foldPath } from './realpath.js';
import { insideRunsRoot } from './tmp.js';
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

/** Why `label` failed: its errno or exit status, and the first line it printed. */
function execFailure(label: string, err: unknown): string {
  const e = err as NodeJS.ErrnoException & { status?: number | null; stderr?: string };
  const why = e.code ?? (typeof e.status === 'number' ? `exit ${e.status}` : 'failed');
  const said = String(e.stderr || e.message || '').trim().split(/\r?\n/)[0]!.slice(0, 200);
  return `${label} ${why}${said ? `: ${said}` : ''}`;
}

/**
 * POSIX: whether `pid` is a zombie — dead, only not yet reaped by its parent.
 * `kill(pid, 0)` still succeeds on one, so liveness alone would call a
 * SIGKILLed child of this process a survivor until its event loop reaps it.
 */
function isZombie(pid: number): boolean {
  try {
    return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5_000,
    }).trim().startsWith('Z');
  } catch {
    return false; // `ps -p` exits 1 once the pid is gone, which pidAlive has already said
  }
}

function pidGone(pid: number): boolean {
  return !pidAlive(pid) || (process.platform !== 'win32' && isZombie(pid));
}

/**
 * Block until `pid` is gone, for at most 2 s. Synchronous on purpose: it also
 * runs in the `exit` hook, where nothing async ever resumes — and `Atomics.wait`
 * on a buffer nobody notifies is the one synchronous sleep Node has.
 */
function waitGone(pid: number): boolean {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 20 && !pidGone(pid); i++) Atomics.wait(sleeper, 0, 0, 100);
  return pidGone(pid);
}

/** One process: its pid, its parent's, and its command line. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  cmd: string;
}

/**
 * Rows of `pid ppid cmd` — tab-separated from PowerShell, space-padded by `ps`.
 * A table without this very process in it, command line and all, is not a
 * table: a CIM query can fail without failing, and reading that as "nothing
 * to kill" is the silent miss this refuses.
 */
export function parseProcessTable(out: string, self = process.pid): ProcessRow[] | string {
  const rows = out.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)[\t ]+(\d+)[\t ](.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! }] : [];
  });
  return rows.some((r) => r.pid === self && r.cmd.trim())
    ? rows
    : `it listed ${rows.length} process(es), and not this one with its command line`;
}

/** Every process — or only `pids`, plus this one for the self-check — or why the table could not be read. */
function processTable(pids?: number[]): ProcessRow[] | string {
  const only = pids && [process.pid, ...pids];
  const [file, args] = process.platform === 'win32'
    ? [join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
        // UTF-8: 5.1 writes a pipe in the OEM code page, so a non-ASCII profile path came back
        // mangled in every command line (measured: `João-ç-—` as `Joao-�--`) and never matched.
        // Stop: a CIM failure must exit non-zero instead of printing nothing.
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; " +
        `Get-CimInstance Win32_Process${only ? ` -Filter '${only.map((p) => `ProcessId=${p}`).join(' OR ')}'` : ''} | ` +
        'ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.ParentProcessId + [char]9 + $_.CommandLine }']]
    : ['ps', only ? ['-o', 'pid=,ppid=,args=', '-p', only.join(',')] : ['-eo', 'pid=,ppid=,args=']];
  try {
    return parseProcessTable(execFileSync(file, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    return execFailure(basename(file), err);
  }
}

/** `pid` and every process under it in `table`, parents first; never this process. */
function subtree(pid: number, table: ProcessRow[]): number[] {
  const tree = [pid];
  for (let i = 0; i < tree.length; i++) {
    for (const r of table) if (r.ppid === tree[i] && r.pid !== process.pid && !tree.includes(r.pid)) tree.push(r.pid);
  }
  return tree;
}

/**
 * Kill `pid` with everything it started. Returns null once `pid` is gone, or
 * why it is not — a refusal (access denied, a protected process) must never
 * read as a kill. win32: `taskkill /T` walks the tree itself. POSIX: SIGKILL to
 * the pid, then to each descendant the process table lists under it, which
 * would otherwise be re-parented to init and outlive it; a descendant is
 * killed, not re-checked. Blocks for at most ~12 s: taskkill's timeout, then
 * `waitGone`.
 */
function killPidTree(pid: number): string | null {
  let why = '';
  if (process.platform === 'win32') {
    try {
      execFileSync(join(SYSTEM32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 10_000,
      });
    } catch (err) {
      // Not the verdict — "already gone" lands here too, and liveness below
      // decides. This is only the reason given if the process did survive.
      why = execFailure('taskkill', err);
    }
  } else {
    const table = processTable();
    for (const p of typeof table === 'string' ? [pid] : subtree(pid, table)) {
      try {
        process.kill(p, 'SIGKILL');
      } catch (err) {
        if (p === pid) why = `SIGKILL ${(err as NodeJS.ErrnoException).code ?? 'failed'}`;
      }
    }
  }
  return waitGone(pid) ? null : why || 'still running 2 s after the kill';
}

const liveChildren = new Set<ChildProcess>();
let exitHooked = false;

/**
 * INV-HYG-04. Kill `child` with everything it started — on win32 `spawnCli`
 * runs the CLI behind `cmd.exe`, so `child.kill()` would end only the shell.
 * Returns null once it is gone, or why it is not; a caller must never read
 * the latter as a kill.
 */
export function killTree(child: ChildProcess): string | null {
  // signalCode too: a child ended by a signal keeps exitCode === null, and its
  // pid may already belong to someone else.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return null;
  const why = killPidTree(child.pid);
  // Killed is killed: the exit sweep must not hit a pid the OS may since have handed on.
  if (!why) liveChildren.delete(child);
  return why;
}

/**
 * Kill `child`'s tree if this process ends first. `exit` fires only for an
 * exit that runs handlers — a throw, `process.exit()` — and under the default
 * disposition SIGINT (Ctrl-C), SIGTERM (`kill <pid>`) and SIGHUP (the terminal
 * closed) end the process without one, so each is turned into one. A hard
 * kill (SIGKILL, TerminateProcess) runs nothing at all; `reapOrphanRuntime`
 * covers that from the next `status` or `--resume`.
 */
export function killOnExit(child: ChildProcess): void {
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => liveChildren.forEach((c) => killTree(c)));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
      process.once(signal, () => process.exit(code));
    }
  }
  liveChildren.add(child);
  child.once('close', () => liveChildren.delete(child));
}

// Flags only this CLI's runtime argv carries (see namesRunDir). tests/spawn.test.ts
// builds its positives from the producers, so renaming one there fails the suite.
const RUNTIME_MARKS = ['--strict-mcp-config', '--disable-builtin-mcps']; // MCP_PROCESS_DENIAL
const CODEX_MARK = '--skip-git-repo-check'; // CODEX_SANDBOX_ARGS

/** `arg` as a whole argument of `line`: bare, or quoted the way `spawnCli` quotes on win32. */
function hasArg(line: string, arg: string): boolean {
  return new RegExp(`(?:^|[\\s"])${arg}(?=["\\s]|$)`).test(line);
}

/**
 * Whether `cmd` is a runtime session this CLI spawned for `outDir`. The run
 * dir rides in `--add-dir <dir>` (claude, copilot — `runtimeSpawnArgs`) or
 * `-C <dir>` (codex — `codexSpawnArgs`), each argument quoted on win32 by
 * `spawnCli`. That alone is not the identity: an operator's own
 * `claude --add-dir <runDir>`, or a `make -C <runDir>`, names the dir the same
 * way. So each arm also needs a flag only this CLI's argv carries — the MCP
 * process denial for claude/copilot, `--skip-git-repo-check` for codex. This
 * CLI's own argv (`--run-dir <dir>`) carries neither arm.
 *
 * The path compares folded as `foldPath` folds it (separators, NFC, and case
 * through the `i` flag); the flags compare exactly, since `-C` is not `-c`.
 */
export function namesRunDir(cmd: string, outDir: string): boolean {
  const line = cmd.replace(/\\/g, '/').normalize('NFC');
  const dir = foldPath(outDir).replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[\\s"])(--add-dir|-c)"?\\s+"?${dir}/?(?=["\\s]|$)`, 'giu');
  return [...line.matchAll(re)].some(([, flag]) =>
    flag === '--add-dir' ? RUNTIME_MARKS.some((m) => hasArg(line, m)) : flag === '-C' && hasArg(line, CODEX_MARK));
}

/**
 * The image a command line runs — argv[0]'s basename. It is all a log may
 * carry of another process: its argv can hold secrets.
 */
function imageName(cmd: string): string {
  const m = /^\s*(?:"([^"]*)"|(\S+))/.exec(cmd);
  return (m?.[1] ?? m?.[2] ?? '').split(/[\\/]/).pop() || 'unknown';
}

/**
 * The pid a run recorded in `run.pid`; 0 when it left none — a foreground or
 * legacy run, never grounds to kill. Throws when the beacon exists but cannot
 * be read as a pid, so a caller about to act on it can say why it did not.
 */
export function readRunPid(outDir: string): number {
  let raw: string;
  try {
    raw = readFileSync(join(outDir, 'run.pid'), 'utf8').trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    throw new Error(`run.pid could not be read (${code ?? (err as Error).message})`);
  }
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`run.pid holds ${JSON.stringify(raw.slice(0, 40))}, not a pid`);
  return pid;
}

/** A process the sweep matched: the image it runs and its pid — never its argv (see `imageName`). */
export interface ReapedProcess {
  name: string;
  pid: number;
}

export type ReapResult =
  /** Nothing could be judged, so nothing was done — and why. */
  | { scanError: string }
  | { killed: ReapedProcess[]; survived: (ReapedProcess & { why: string })[] };

/** The two host boundaries of the sweep, injectable so a test can reach every outcome. */
export interface ReapDeps {
  /** Every process — or only `pids`, plus this one — or why the table could not be read. */
  table: (pids?: number[]) => ProcessRow[] | string;
  /** Kill a pid with everything it started: null once it is gone, or why it is not. */
  killPid: (pid: number) => string | null;
}

const HOST: ReapDeps = { table: processTable, killPid: killPidTree };

/**
 * INV-HYG-04. Kill the runtime sessions of a run whose process died without
 * killing them — a hard kill runs no exit handler. Acts only when the run's
 * `run.pid` names a dead process, and only on processes whose argv hands them
 * this run dir (`namesRunDir`). Matched by argv rather than by a recorded pid:
 * on win32 the recorded pid would be the `cmd.exe` in front of the runtime,
 * which dies with the CLI and leaves the runtime unreachable through it.
 *
 * The table is a second or more old by the time a kill lands (PowerShell's CIM
 * query), so each target is re-read just before it — a pid that exited and was
 * handed to another process no longer matches — and so is `run.pid`: a
 * `--resume` that claimed it meanwhile owns these sessions.
 * ponytail: the re-read narrows the window to the second query's own tail;
 * closing it needs a kill through a handle opened on the matched process.
 */
export function reapOrphanRuntime(outDir: string, deps: ReapDeps = HOST): ReapResult {
  let runPid: number;
  try {
    runPid = readRunPid(outDir);
  } catch (err) {
    return { scanError: `${(err as Error).message} — cannot tell whether the run's process is alive` };
  }
  if (!runPid || pidAlive(runPid)) return { killed: [], survived: [] };
  const table = deps.table();
  if (typeof table === 'string') return { scanError: `could not read the process table: ${table}` };
  const matched = table.filter((p) => p.pid !== process.pid && namesRunDir(p.cmd, outDir));
  // A match whose parent matched too (the runtime behind a surviving cmd.exe) goes
  // down with its parent's tree; killing it after that would hit whoever got its pid next.
  const roots = matched.filter((p) => !matched.some((q) => q.pid === p.ppid));
  if (roots.length === 0) return { killed: [], survived: [] };
  const fresh = deps.table(roots.map((p) => p.pid));
  if (typeof fresh === 'string') return { scanError: `could not re-read the matched processes before the kill: ${fresh}` };
  let claimed = -1;
  try {
    claimed = readRunPid(outDir);
  } catch {
    // Rewritten under us — whoever did it owns the run now.
  }
  if (claimed !== runPid) return { killed: [], survived: [] };
  const killed: ReapedProcess[] = [];
  const survived: (ReapedProcess & { why: string })[] = [];
  for (const p of roots) {
    // Gone since the scan, or its pid now runs something else: nothing of this run to kill.
    if (!fresh.some((f) => f.pid === p.pid && namesRunDir(f.cmd, outDir))) continue;
    const who = { name: imageName(p.cmd), pid: p.pid };
    const why = deps.killPid(p.pid);
    if (why) survived.push({ ...who, why });
    else killed.push(who);
  }
  return { killed, survived };
}

/** The one line recorded for a sweep, or null when there is nothing to say. */
export function describeReap(r: ReapResult): string | null {
  if ('scanError' in r) return `orphaned runtime sessions NOT checked — ${r.scanError}`;
  const who = (p: ReapedProcess) => `${p.name} pid ${p.pid}`;
  const parts = [
    r.killed.length ? `killed its orphaned runtime session (${r.killed.map(who).join(', ')})` : '',
    ...r.survived.map((p) => `could NOT kill orphaned runtime ${who(p)} (${p.why}) — end it manually`),
  ].filter(Boolean);
  return parts.length ? `run process died — ${parts.join('; ')}` : null;
}

/**
 * The sweep as `status` and `--resume` both run it: only for a run dir inside
 * `runsRoot` — a run id like `../x` must not pick an arbitrary directory as
 * the kill predicate — and recorded under the `reap` phase, which the progress
 * snapshot never takes for the run's own headline.
 */
export function reapAndRecord(outDir: string, runsRoot: string, deps: ReapDeps = HOST): { result: ReapResult; line: string | null } {
  if (!insideRunsRoot(outDir, runsRoot)) return { result: { killed: [], survived: [] }, line: null };
  const result = reapOrphanRuntime(outDir, deps);
  const line = describeReap(result);
  if (line) appendProgress(outDir, 'reap', line);
  return { result, line };
}

/**
 * `--resume`'s first act: end what the killed attempt left running, THEN claim
 * `run.pid` — in the other order the sweep reads this process's own live pid
 * and never acts. Refuses while a session survives, since it would keep
 * writing into the attempts about to be recovered; `run.pid` stays unclaimed,
 * so the next `status` or `--resume` tries again.
 */
export function reapThenClaimRunPid(outDir: string, runsRoot: string, deps: ReapDeps = HOST): string | null {
  const { result, line } = reapAndRecord(outDir, runsRoot, deps);
  if ('survived' in result && result.survived.length) {
    throw new Error(`resume recovery refused [orphan-runtime-alive]: ${line} — it would keep writing into the attempts being recovered`);
  }
  writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
  return line;
}
