import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The closed set of run lifecycle phases. A typo here is a compile error, not a silently blank feed. */
export type ProgressPhase = 'gather' | 'dispatch' | 'running' | 'dedupe' | 'post' | 'done' | 'resume';

/** One line of the run's live progress feed (~/.pr-review/runs/<id>/progress.ndjson). */
export interface ProgressEvent {
  ts: number;
  phase: ProgressPhase;
  detail: string;
}

export const PROGRESS_FILE = 'progress.ndjson';

/** Append a checkpoint. Best-effort: a progress-write failure must never break a run. */
export function appendProgress(outDir: string, phase: ProgressPhase, detail = ''): void {
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
      const e = JSON.parse(t) as ProgressEvent;
      // tolerate a truncated/partial last line written by the live run
      if (typeof e?.ts === 'number' && typeof e?.phase === 'string') out.push(e);
    } catch {
      // partial line still being written — skip
    }
  }
  return out;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/**
 * Render the current live snapshot from the progress feed — the running phase
 * and elapsed. Pure (no fs) so it is unit-testable against a fixture event
 * list. `nowMs` makes elapsed advance between polls even when no new event has
 * landed; omit it for a deterministic event-relative elapsed (tests).
 */
export function renderProgressSnapshot(events: ProgressEvent[], nowMs?: number): string {
  if (events.length === 0) return 'starting…';
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const elapsed = fmtElapsed((nowMs ?? last.ts) - first.ts);
  return `⏳ ${last.phase}${last.detail ? ` — ${last.detail}` : ''}  ·  ${elapsed} elapsed`;
}
