import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { controlDirForRun, ERROR_FILE, RUNS_ROOT } from '../util/tmp.js';
import { REVIEWER_OUTPUT_FILES } from '../dispatch/single-session.js';
import { readProgress, renderProgressSnapshot } from '../util/progress.js';
import type { DeliveryState } from '../dispatch/delivery.js';
import {
  readAuthoritativeDeliveryState,
  readAuthoritativeDispatchPlan,
  readAuthoritativeFinalization,
  type DispatchPlan,
} from '../dispatch/delivery.js';
import { atomicFileExistsSync } from '../util/atomic-json.js';

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
 * `interrupted` must mean "resume will actually work". A corrupt or truncated
 * findings file (the orchestrator-flake class) exists on disk but resume can't
 * load it — reporting `interrupted` would hint a --resume that dead-ends and
 * hide the error.txt a pipeline failure just wrote. Mirrors resumeReview's
 * loader: ANY output file that parses to the {reviewers:[…]} shape is enough.
 */
function hasResumableOutput(outDir: string): boolean {
  return REVIEWER_OUTPUT_FILES.some((f) => {
    const p = join(outDir, f);
    if (!existsSync(p)) return false;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { reviewers?: unknown };
      return !!parsed && Array.isArray(parsed.reviewers);
    } catch {
      return false;
    }
  });
}

function readDeliveryStatus(outDir: string): DeliveryState | null {
  const path = join(outDir, 'delivery-state.json');
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as DeliveryState;
    return state?.schemaVersion === 1 && Array.isArray(state.planned) && Array.isArray(state.valid) ? state : null;
  } catch {
    return null;
  }
}

/**
 * The authenticated plan + delivery state for a run, or null when either is
 * absent or fails authentication.
 *
 * Exported because `verify` audits the same run from the same source of truth:
 * a second reader that reached for the run-dir mirrors instead would grade a
 * run against artifacts the runtime itself can write.
 */
export function readAuthoritativeControl(
  outDir: string,
  home?: string,
): { plan: DispatchPlan; state: DeliveryState } | null {
  const controlDir = controlDirForRun(outDir, home);
  const planPath = join(controlDir, 'dispatch-plan.json');
  const statePath = join(controlDir, 'delivery-state.json');
  try {
    if (!atomicFileExistsSync(planPath) || !atomicFileExistsSync(statePath)) return null;
    const plan = readAuthoritativeDispatchPlan(planPath);
    return { plan, state: readAuthoritativeDeliveryState(statePath, plan) };
  } catch {
    return null;
  }
}

function deliverySnapshot(state: DeliveryState): string {
  const unresolved = state.missing.length + state.invalid.length;
  const parts = [
    `reviewers ${state.valid.length}/${state.planned.length}`,
    `${state.recoveredFindingCount} finding${state.recoveredFindingCount === 1 ? '' : 's'}`,
  ];
  if (state.missing.length > 0) parts.push(`${state.missing.length} missing`);
  if (state.invalid.length > 0) parts.push(`${state.invalid.length} invalid`);
  if (unresolved === 0 && state.verifier.state === 'required') parts.push('verifier required');
  if (state.verifier.state === 'missing' || state.verifier.state === 'invalid') parts.push(`verifier ${state.verifier.state}`);
  if (state.codex?.state === 'pending' || state.codex?.state === 'failed') parts.push(`codex ${state.codex.state}`);
  return parts.join(' · ');
}

function shellQuote(value: string): string {
  return process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function resumeCommand(plan: DispatchPlan, runId: string): string {
  const mode = plan.execution.dryRun ? ' --dry-run' : '';
  const invocation = plan.cliArtifact
    ? `${shellQuote(process.execPath)} ${shellQuote(plan.cliArtifact.path)}`
    : 'pr-review';
  return `${invocation} review ${shellQuote(plan.pr.url)} --resume ${shellQuote(runId)}${mode}`;
}

function legacyResumeCommand(outDir: string, runId: string): string {
  try {
    const gather = JSON.parse(readFileSync(join(outDir, 'pr-review-gather.json'), 'utf8')) as { pr?: { url?: unknown } };
    if (typeof gather.pr?.url === 'string' && gather.pr.url.length > 0) {
      return `pr-review review ${shellQuote(gather.pr.url)} --resume ${shellQuote(runId)}`;
    }
  } catch {
    // Historical runs can predate or have lost their gather artifact.
  }
  return `pr-review review <pr-url> --resume ${shellQuote(runId)}`;
}

function hasRecoveryAuthority(outDir: string): boolean {
  const controlDir = controlDirForRun(outDir);
  return [join(controlDir, 'dispatch-plan.json'), join(controlDir, 'delivery-state.json')]
    .every((path) => existsSync(path) || existsSync(join(dirname(path), `.${basename(path)}.bak`)));
}

function hasAnyPlannedControl(outDir: string): boolean {
  const controlDir = controlDirForRun(outDir);
  return [
    join(outDir, 'dispatch-plan.json'),
    join(outDir, 'delivery-state.json'),
    join(controlDir, 'dispatch-plan.json'),
    join(controlDir, 'delivery-state.json'),
  ].some((path) => existsSync(path) || existsSync(join(dirname(path), `.${basename(path)}.bak`)));
}

/**
 * Render the current state of a run for the slash-command poll loop:
 *  - `done`        → the summary is on disk; text IS the summary.
 *  - `running`     → the run process is alive; a live progress snapshot.
 *  - `interrupted` → the process died with reviewer output on disk but no summary; resume it.
 *  - `failed`      → the process died before producing any findings; the
 *                    recorded fatal error (error.txt) is surfaced inline when
 *                    present, plus the detached.log pointer.
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
  const errPath = join(outDir, ERROR_FILE);
  const alive = runAlive(outDir);
  const snapshot = renderProgressSnapshot(readProgress(outDir), now);
  const recoveryAuthorityExists = hasRecoveryAuthority(outDir);
  const authoritative = readAuthoritativeControl(outDir);
  const authoritativeDelivery = authoritative?.state ?? null;
  const delivery = authoritativeDelivery ?? readDeliveryStatus(outDir);

  if (alive === true) {
    const counts = delivery ? `\n${deliverySnapshot(delivery)}` : '';
    return { state: 'running', text: `${snapshot}${counts}\n\n(run ${runId} in progress — poll again shortly)` };
  }

  if (hasAnyPlannedControl(outDir) && !authoritativeDelivery) {
    return {
      state: 'failed',
      text: `${snapshot}\n\nRecovery control records are unreadable or failed authentication; refusing to trust run artifacts.`,
    };
  }

  if (
    authoritative &&
    (authoritativeDelivery?.kind === 'running' || authoritativeDelivery?.kind === 'recoverable-incomplete') &&
    recoveryAuthorityExists
  ) {
    return {
      state: 'interrupted',
      text:
        `${snapshot}\n${deliverySnapshot(authoritativeDelivery)}\n\n` +
        `Reviewer delivery is incomplete; recovered findings are not accepted or posted.\n` +
        `Resume re-dispatches only unresolved reviewers: ${resumeCommand(authoritative.plan, runId)}`,
    };
  }

  if (authoritativeDelivery?.kind === 'terminal-incomplete') {
    const diagnostic = existsSync(errPath) ? `\n\n${readFileSync(errPath, 'utf8').trim()}` : '';
    return {
      state: 'failed',
      text:
        `${snapshot}\n${deliverySnapshot(authoritativeDelivery)}\n\n` +
        `Reviewer delivery is terminal: ${authoritativeDelivery.reasonCodes.join(', ') || 'unknown reason'}.` +
        diagnostic,
    };
  }

  if (authoritative && authoritativeDelivery?.kind === 'complete' && !existsSync(summaryPath)) {
    return {
      state: 'interrupted',
      text:
        `${snapshot}\n${deliverySnapshot(authoritativeDelivery)}\n\n` +
        `Delivery is complete, but finalization stopped before the summary. Resume without re-review: ` +
        resumeCommand(authoritative.plan, runId),
    };
  }

  if (authoritativeDelivery?.kind === 'complete' && authoritative) {
    try {
      const finalization = readAuthoritativeFinalization(outDir, undefined, authoritative.plan);
      if (!finalization) {
        return {
          state: 'interrupted',
          text: `${snapshot}\n\nDelivery is complete, but authenticated finalization is absent. Resume finalization.`,
        };
      }
      if (finalization.exitCode === 2) {
        return { state: 'failed', text: readFileSync(finalization.summaryPath, 'utf8') };
      }
      return { state: 'done', text: readFileSync(finalization.summaryPath, 'utf8') };
    } catch {
      return { state: 'failed', text: `${snapshot}\n\nAuthenticated finalization is unreadable or failed integrity validation.` };
    }
  }

  if (existsSync(errPath)) {
    const errTxt = readFileSync(errPath, 'utf8').trim();
    const summary = existsSync(summaryPath) ? `\n\n${readFileSync(summaryPath, 'utf8')}` : '';
    return { state: 'failed', text: `${errTxt}\n\nSee ${join(outDir, 'detached.log')}${summary}` };
  }

  if (existsSync(summaryPath) && !authoritativeDelivery) {
    return { state: 'done', text: readFileSync(summaryPath, 'utf8') };
  }

  // Alive, or liveness unknown but findings not yet complete → still running.
  if (alive === null && !hasReviewerOutput(outDir) && !delivery) {
    return { state: 'running', text: `${snapshot}\n\n(run ${runId} in progress — poll again shortly)` };
  }

  if (hasResumableOutput(outDir)) {
    return {
      state: 'interrupted',
      text:
        `${snapshot}\n\nLegacy consolidated reviewer output is available for replay.\n` +
        `  Resume: ${legacyResumeCommand(outDir, runId)}`,
    };
  }
  return {
    state: 'failed',
    text: `${snapshot}\n\n✗ the run stopped before producing findings — see ${join(outDir, 'detached.log')}`,
  };
}
