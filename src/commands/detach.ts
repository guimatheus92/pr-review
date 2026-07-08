import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ensureRunDir } from '../util/tmp.js';
import { detectProvider } from '../providers/index.js';

/**
 * Start `review` in a detached background process and return its run id/dir
 * immediately, so the caller (slash command) can poll `status <id>` instead of
 * blocking a single Bash call past the host's ~10-min timeout. The child writes
 * its console output to `<dir>/detached.log`; the review artifacts (summary,
 * findings, progress feed) land in the run dir as usual.
 *
 * `restArgv` is the original `review …` argv with `--detach` stripped; we append
 * `--run-dir <dir>` so parent and child share one run dir.
 */
export function detachReview(prUrl: string, restArgv: string[]): { runId: string; outDir: string } {
  const provider = detectProvider(prUrl);
  const ref = provider.parseUrl(prUrl);
  const outDir = ensureRunDir(ref ?? undefined);
  const log = openSync(join(outDir, 'detached.log'), 'a');
  const cliPath = process.argv[1]!;
  const child = spawn(process.execPath, [cliPath, ...restArgv, '--run-dir', outDir], {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  child.unref();
  return { runId: basename(outDir), outDir };
}
