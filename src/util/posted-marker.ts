import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Written to the run dir after a publish run posts at least one comment. On a
 * later `--resume`, a marker showing a COMPLETE post (posted === attempted)
 * makes the run refuse to re-post — the retry idempotency guard. A partial
 * post is intentionally NOT treated as complete so resume can recover the
 * un-posted findings.
 */
export interface PostedMarker {
  postedAt: number;
  posted: number;
  attempted: number;
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
