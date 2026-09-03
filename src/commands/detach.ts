import { spawn as nodeSpawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../config.js';
import { resolvePr } from '../providers/index.js';
import { gitTopLevel } from '../util/git.js';
import { ensureRunDir } from '../util/tmp.js';

export interface DetachResult {
  runId: string;
  outDir: string;
}

/**
 * Start `review` in a detached background process and return its run id/dir
 * immediately, so the caller (slash command) can poll `status <id>` instead of
 * blocking a single Bash call past the host's ~10-min timeout. The child writes
 * its console output to `<dir>/detached.log`; the review artifacts (summary,
 * findings, progress feed) land in the run dir as usual.
 *
 * `argv` is the original `review …` argv (process.argv.slice(2)); we strip
 * `--detach` and append `--run-dir <dir>` so parent and child share one run dir
 * — the whole child-command transform lives here, in one place.
 *
 * `spawnFn` and `resolveAuthEnv` are test seams.
 */
export function detachReview(
  prUrl: string,
  argv: string[],
  spawnFn: typeof nodeSpawn = nodeSpawn,
  resolveAuthEnv?: (url: string) => Record<string, string>,
  homeOverride?: string,
): DetachResult {
  // Parse the URL first, in the foreground: a bad URL must fail the launch
  // here — not hand back a run-id whose detached child dies on it minutes
  // later. Then resolve auth, also foreground: the keyring-backed CLI
  // fallbacks (`gh auth token`, `az account get-access-token`) can flake in a
  // detached child. Both are ordered before the run-dir mint so a failed
  // pre-flight leaves nothing behind.
  const invocationCwd = process.cwd();
  const repoRoot = gitTopLevel(invocationCwd) ?? invocationCwd;
  const trustedConfig = loadConfig({
    cwd: invocationCwd,
    repoRoot,
    homeOverride,
    includeRepoConfig: false,
  }).config;
  const { provider, ref } = resolvePr(prUrl, trustedConfig.hosts);
  const authEnv = resolveAuthEnv ? resolveAuthEnv(prUrl) : provider.authEnv(ref);
  const outDir = ensureRunDir(ref);
  const childArgs = argv.filter((a) => a !== '--detach').concat('--run-dir', outDir);
  const log = openSync(join(outDir, 'detached.log'), 'a');
  const cliPath = process.argv[1]!;
  const child = spawnFn(process.execPath, [cliPath, ...childArgs], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, ...authEnv },
  });
  // The parent exits right after this returns, so a spawn failure would vanish
  // without an explicit listener.
  child.on('error', (err) => {
    process.stderr.write(`[detach] failed to start background review: ${err.message}\n`);
  });
  child.unref();
  // The child inherited its own handle to the log via stdio; close the parent's
  // copy so we don't leak the fd (and, on Windows, so it doesn't pin the dir).
  closeSync(log);
  return { runId: basename(outDir), outDir };
}
