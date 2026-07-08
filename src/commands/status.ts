import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_ROOT } from '../util/tmp.js';
import { readProgress, renderProgressSnapshot } from '../util/progress.js';

export type StatusState = 'done' | 'running' | 'interrupted' | 'missing';

export interface StatusResult {
  state: StatusState;
  text: string;
}

/**
 * Render the current state of a run for the slash-command poll loop:
 *  - `done`        → the summary is on disk; text IS the summary.
 *  - `interrupted` → reviewers finished but posting never completed; resume it.
 *  - `running`     → a live progress snapshot.
 *  - `missing`     → no such run dir.
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

  const snapshot = renderProgressSnapshot(readProgress(outDir), now);
  const hasReviewerOutput =
    existsSync(join(outDir, 'single-session-findings.json')) ||
    existsSync(join(outDir, 'phase1-findings.json'));

  if (hasReviewerOutput) {
    return {
      state: 'interrupted',
      text:
        `${snapshot}\n\n⚠ reviewers finished but the run was interrupted before posting.\n` +
        `  Finish it (fast — no re-review): pr-review review <pr-url> --resume ${runId}`,
    };
  }
  return { state: 'running', text: `${snapshot}\n\n(run ${runId} in progress — poll again shortly)` };
}
