import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '../types.js';

/**
 * Written to the run dir once a publish run posts at least one comment. Its
 * mere presence makes `--resume` refuse to re-post (the retry idempotency
 * guard); `findingKeys` is recorded for future per-finding skipping.
 */
export interface PostedMarker {
  postedAt: number;
  posted: number;
  attempted: number;
  findingKeys: string[];
}

const MARKER_FILE = 'posted.marker';

/** Stable identity of a finding: file + line + body. Deterministic across runs. */
export function findingKey(f: Finding): string {
  return createHash('sha256').update(`${f.file ?? ''}|${f.line ?? ''}|${f.body}`).digest('hex');
}

export function readPostedMarker(outDir: string): PostedMarker | null {
  const p = join(outDir, MARKER_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PostedMarker;
  } catch {
    return null;
  }
}

export function writePostedMarker(outDir: string, m: Omit<PostedMarker, 'postedAt'>): void {
  writeFileSync(join(outDir, MARKER_FILE), JSON.stringify({ postedAt: Date.now(), ...m }, null, 2), 'utf8');
}
