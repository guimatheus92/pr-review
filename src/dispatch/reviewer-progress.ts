import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../util/atomic-json.js';

export const REVIEWER_PROGRESS_FILE = 'reviewer-progress.ndjson';

export type ReviewerProgressKind =
  | 'session-attempt-started'
  | 'output-first-seen'
  | 'output-promoted'
  | 'output-invalid'
  | 'recovery-started'
  | 'recovery-completed'
  | 'phase1-assembled'
  | 'verifier-decision'
  | 'verifier-started'
  | 'verifier-completed'
  | 'consolidated-assembled';

export interface ReviewerProgressEvent {
  ts: number;
  kind: ReviewerProgressKind;
  reviewer?: string;
  attempt?: number;
  bytes?: number;
  findingCount?: number;
  digest?: string;
  detail?: string;
}

export function appendReviewerProgress(
  outDir: string,
  event: Omit<ReviewerProgressEvent, 'ts'> & { ts?: number },
): void {
  try {
    appendFileSync(
      join(outDir, REVIEWER_PROGRESS_FILE),
      JSON.stringify({ ts: event.ts ?? Date.now(), ...event }) + '\n',
      'utf8',
    );
  } catch {
    // Observability must never break reviewer delivery.
  }
}

export function readReviewerProgress(outDir: string): ReviewerProgressEvent[] {
  const path = join(outDir, REVIEWER_PROGRESS_FILE);
  if (!existsSync(path)) return [];
  const events: ReviewerProgressEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as ReviewerProgressEvent;
      if (typeof event.ts === 'number' && typeof event.kind === 'string') events.push(event);
    } catch {
      // Tolerate the final line while another process is appending it.
    }
  }
  return events;
}

export function watchAttemptOutputs(
  outDir: string,
  entries: Array<{ reviewer: string; attempt: number; path: string }>,
  intervalMs = 1_500,
): { stop(): void } {
  const seen = new Set<string>();
  const scan = () => {
    for (const entry of entries) {
      if (seen.has(entry.path) || !existsSync(entry.path)) continue;
      seen.add(entry.path);
      try {
        appendReviewerProgress(outDir, {
          kind: 'output-first-seen',
          reviewer: entry.reviewer,
          attempt: entry.attempt,
          bytes: statSync(entry.path).size,
        });
      } catch {
        // The file can disappear between exists/stat while an agent replaces it.
      }
    }
  };
  const timer = setInterval(scan, intervalMs);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
      scan();
    },
  };
}

export function describePromotedOutput(path: string): { bytes: number; findingCount: number; digest: string } | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    return { bytes: Buffer.byteLength(raw), findingCount: value.length, digest: sha256(raw) };
  } catch {
    return null;
  }
}