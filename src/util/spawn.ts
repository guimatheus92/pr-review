import { spawn, type ChildProcess, type ChildProcessByStdio, type StdioOptions } from 'node:child_process';
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
