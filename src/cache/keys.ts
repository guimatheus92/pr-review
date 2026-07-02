import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GatherOutput, PrRef } from '../types.js';

export const CACHE_ROOT = join(homedir(), '.pr-review', 'cache');

export function gatherCacheKey(ref: PrRef, headSha: string, lastCommentId: string): string {
  return `${ref.provider}-${ref.owner}-${ref.repo}-${ref.number}-${headSha}-${lastCommentId}`;
}

export function gatherCachePath(ref: PrRef, headSha: string, lastCommentId: string): string {
  return join(
    CACHE_ROOT,
    ref.provider,
    `${ref.owner}__${ref.repo}`,
    String(ref.number),
    `${headSha.slice(0, 12)}-${lastCommentId}.json`,
  );
}

export function lastCommentIdFrom(gather: GatherOutput): string {
  if (gather.existingComments.length === 0) return 'none';
  const sorted = gather.existingComments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = sorted[sorted.length - 1]!;
  return last.id;
}

