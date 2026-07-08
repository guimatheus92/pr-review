import { spawn as nodeSpawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { newRunDirForUrl } from '../providers/index.js';

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
 * `spawnFn` is a test seam.
 */
export function detachReview(prUrl: string, argv: string[], spawnFn: typeof nodeSpawn = nodeSpawn): DetachResult {
  const outDir = newRunDirForUrl(prUrl);
  const childArgs = argv.filter((a) => a !== '--detach').concat('--run-dir', outDir);
  const log = openSync(join(outDir, 'detached.log'), 'a');
  const cliPath = process.argv[1]!;
  const child = spawnFn(process.execPath, [cliPath, ...childArgs], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  // The parent exits right after this returns, so a spawn failure would vanish
  // without an explicit listener.
  child.on('error', (err) => {
    process.stderr.write(`[detach] failed to start background review: ${err.message}\n`);
  });
  child.unref();
  return { runId: basename(outDir), outDir };
}
