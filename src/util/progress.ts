import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One line of the run's live progress feed (~/.pr-review/runs/<id>/progress.ndjson). */
export interface ProgressEvent {
  ts: number;
  phase: string;
  detail: string;
}

export const PROGRESS_FILE = 'progress.ndjson';

/** Append a checkpoint. Best-effort: a progress-write failure must never break a run. */
export function appendProgress(outDir: string, phase: string, detail = ''): void {
  try {
    appendFileSync(
      join(outDir, PROGRESS_FILE),
      JSON.stringify({ ts: Date.now(), phase, detail }) + '\n',
      'utf8',
    );
  } catch {
    // progress is cosmetic
  }
}

export function readProgress(outDir: string): ProgressEvent[] {
  const p = join(outDir, PROGRESS_FILE);
  if (!existsSync(p)) return [];
  const out: ProgressEvent[] = [];
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ProgressEvent);
    } catch {
      // partial/last line still being written — skip
    }
  }
  return out;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Render the current live snapshot from the progress feed — the running phase,
 * elapsed, and how many reviewers have reported back so far. Pure (no fs) so it
 * is unit-testable against a fixture event list. `nowMs` makes elapsed advance
 * between polls even when no new event has landed; omit it for a deterministic
 * event-relative elapsed (tests).
 */
export function renderProgressSnapshot(events: ProgressEvent[], nowMs?: number): string {
  if (events.length === 0) return 'starting…';
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const elapsed = fmtElapsed((nowMs ?? last.ts) - first.ts);

  const reviewerDone = events.filter((e) => e.phase === 'reviewer').length;
  const dispatch = events.find((e) => e.phase === 'dispatch' && /(\d+)\s+reviewers/.test(e.detail));
  const total = dispatch ? Number(/(\d+)\s+reviewers/.exec(dispatch.detail)![1]) : undefined;

  const lines = [`⏳ ${last.phase}${last.detail ? ` — ${last.detail}` : ''}  ·  ${elapsed} elapsed`];
  if (reviewerDone > 0 || total) {
    lines.push(`   reviewers: ${reviewerDone}${total ? `/${total}` : ''} done`);
  }
  return lines.join('\n');
}
