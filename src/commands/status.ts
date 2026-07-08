import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT } from '../util/tmp.js';
import { REVIEWER_OUTPUT_FILES } from '../dispatch/single-session.js';
import { readProgress, renderProgressSnapshot } from '../util/progress.js';

export type StatusState = 'done' | 'running' | 'interrupted' | 'failed' | 'missing';

export interface StatusResult {
  state: StatusState;
  text: string;
}

/** Exit codes the slash-command poll loop branches on. Kept next to the states it maps. */
export function statusExitCode(state: StatusState): number {
  switch (state) {
    case 'done':
      return 0;
    case 'missing':
      return 1;
    case 'running':
      return 20;
    case 'interrupted':
      return 21;
    case 'failed':
      return 22;
  }
}

/** True if a process with this pid is alive. EPERM (exists, not ours) counts as alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** null = unknown (no run.pid, e.g. an old or foreground run); else whether the run's process is alive. */
function runAlive(outDir: string): boolean | null {
  const p = join(outDir, 'run.pid');
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  return pid > 0 ? pidAlive(pid) : null;
}

function hasReviewerOutput(outDir: string): boolean {
  return REVIEWER_OUTPUT_FILES.some((f) => existsSync(join(outDir, f)));
}

/**
 * Render the current state of a run for the slash-command poll loop:
 *  - `done`        → the summary is on disk; text IS the summary.
 *  - `running`     → the run process is alive; a live progress snapshot.
 *  - `interrupted` → the process died with reviewer output on disk but no summary; resume it.
 *  - `failed`      → the process died before producing any findings; check detached.log.
 *  - `missing`     → no such run dir.
 *
 * Liveness (run.pid) is what separates a slow-but-healthy run from a dead one —
 * an intermediate artifact like phase1-findings.json must NOT read as "interrupted"
 * while the run is still going, or the poller would fire a racing --resume.
 */
export function runStatus(runId: string, now = Date.now()): StatusResult {
  const outDir = join(RUNS_ROOT, runId);
  if (!existsSync(outDir)) {
    return { state: 'missing', text: `run ${runId} not found under ${RUNS_ROOT}` };
  }

  const summaryPath = join(outDir, 'pr-review-summary.md');
  if (existsSync(summaryPath)) {
    return { state: 'done', text: readFileSync(summaryPath, 'utf8') };
  }

  const alive = runAlive(outDir);
  const snapshot = renderProgressSnapshot(readProgress(outDir), now);

  // Alive, or liveness unknown but findings not yet complete → still running.
  if (alive === true || (alive === null && !hasReviewerOutput(outDir))) {
    return { state: 'running', text: `${snapshot}\n\n(run ${runId} in progress — poll again shortly)` };
  }

  if (hasReviewerOutput(outDir)) {
    return {
      state: 'interrupted',
      text:
        `${snapshot}\n\n⚠ reviewers finished but the run stopped before posting.\n` +
        `  Finish it (fast — no re-review): pr-review review <pr-url> --resume ${runId}`,
    };
  }
  return {
    state: 'failed',
    text: `${snapshot}\n\n✗ the run stopped before producing findings — see ${join(outDir, 'detached.log')}`,
  };
}
