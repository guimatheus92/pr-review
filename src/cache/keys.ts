import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeOwner, safeSegment } from '../util/tmp.js';
import { authorityCacheSegment } from '../providers/identity.js';
import type { ExistingComment, PrRef } from '../types.js';

export const CACHE_ROOT = join(homedir(), '.pr-review', 'cache');

export function gatherCacheScope(ref: PrRef): string {
  const parts = [authorityCacheSegment(ref), safeOwner(ref)].filter((part): part is string => part !== null);
  if (ref.provider === 'azuredevops') parts.push(safeSegment(ref.project ?? '_unresolved-project'));
  parts.push(safeSegment(ref.repo));
  return parts.join('__');
}

export function gatherCacheKey(ref: PrRef, headSha: string, lastCommentId: string): string {
  return `${ref.provider}-${gatherCacheScope(ref)}-${ref.number}-${headSha}-${lastCommentId}`;
}

export function gatherCachePath(ref: PrRef, headSha: string, lastCommentId: string): string {
  return join(
    CACHE_ROOT,
    ref.provider,
    gatherCacheScope(ref),
    String(ref.number),
    `${headSha.slice(0, 12)}-${lastCommentId}.json`,
  );
}

export function lastCommentIdFrom(comments: ExistingComment[]): string {
  if (comments.length === 0) return 'none';
  const sorted = comments.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = sorted[sorted.length - 1]!;
  return last.id;
}

