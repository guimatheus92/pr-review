import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Written to the run dir after every publish attempt — including one that
 * posted nothing. On a later `--resume`, a marker showing a COMPLETE post
 * (posted === attempted) makes the run refuse to re-post — the retry
 * idempotency guard. A partial post is intentionally NOT treated as complete
 * so resume can recover the un-posted findings.
 *
 * Recording the attempt regardless of outcome is the point: gating the write
 * on `posted > 0` meant a run whose counts were wrong left no guard at all,
 * which is exactly how the field incident's `--resume` re-posted 56 comments.
 * The counts are only as good as the verification behind them, so `verified`
 * carries that: false means at least one write's outcome is unknown, and the
 * resume gate treats it like a corrupt marker — fail closed, require
 * `--force-post`. Without it, "stop rather than re-issue on an unverifiable
 * write" would just move the duplicate to the next resume.
 */
export interface PostedMarker {
  postedAt: number;
  posted: number;
  attempted: number;
  /** Absent on markers written before 0.6.1; treated as verified. */
  verified?: boolean;
}

const MARKER_FILE = 'posted.marker';

/**
 * `null` = no marker (never posted → safe to post). `'corrupt'` = a marker file
 * exists but is unreadable/misshapen — a post attempt happened but we can't
 * trust its outcome, so callers should fail CLOSED (refuse to re-post) rather
 * than risk duplicates.
 */
export function readPostedMarker(outDir: string): PostedMarker | 'corrupt' | null {
  const p = join(outDir, MARKER_FILE);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as Partial<PostedMarker>;
    if (typeof m?.posted === 'number' && typeof m?.attempted === 'number') return m as PostedMarker;
    return 'corrupt';
  } catch {
    return 'corrupt';
  }
}

export function writePostedMarker(outDir: string, m: Omit<PostedMarker, 'postedAt'>): void {
  writeFileSync(join(outDir, MARKER_FILE), JSON.stringify({ postedAt: Date.now(), ...m }, null, 2), 'utf8');
}
