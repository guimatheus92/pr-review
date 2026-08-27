import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CACHE_ROOT, gatherCachePath, gatherCacheScope, lastCommentIdFrom } from './keys.js';
import { safeOwner, safeSegment } from '../util/tmp.js';
import type { GatherOutput, PrRef } from '../types.js';

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface CacheHit<T> {
  data: T;
  path: string;
  ageMs: number;
}

export function readGatherCache(ref: PrRef, headSha: string, lastCommentId: string): CacheHit<GatherOutput> | null {
  const path = gatherCachePath(ref, headSha, lastCommentId);
  const data = readJson<GatherOutput>(path);
  if (!data) return null;
  const stat = statSync(path);
  return { data, path, ageMs: Date.now() - stat.mtimeMs };
}

export function writeGatherCache(gather: GatherOutput): string {
  const path = gatherCachePath(gather.pr, gather.metadata.headSha, lastCommentIdFrom(gather.existingComments));
  writeJson(path, gather);
  return path;
}

export interface CacheInfo {
  root: string;
  totalFiles: number;
  totalBytes: number;
  gatherEntries: number;
  /** Left over from the removed per-reviewer response cache; counts stale files under responses/ until cleared. */
  responseEntries: number;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.json')) out.push(full);
  }
  return out;
}

export function cacheInfo(): CacheInfo {
  const files = walk(CACHE_ROOT);
  let totalBytes = 0;
  let gatherEntries = 0;
  let responseEntries = 0;
  for (const f of files) {
    const sz = statSync(f).size;
    totalBytes += sz;
    if (f.includes(`${join('responses')}`)) responseEntries++;
    else gatherEntries++;
  }
  return { root: CACHE_ROOT, totalFiles: files.length, totalBytes, gatherEntries, responseEntries };
}

function cacheTargetMatchesRef(target: string, ref: PrRef): boolean {
  return walk(target).some((file) => {
    const cached = readJson<GatherOutput>(file)?.pr;
    return (
      cached?.provider === ref.provider &&
      cached.owner.toLowerCase() === ref.owner.toLowerCase() &&
      cached.repo.toLowerCase() === ref.repo.toLowerCase() &&
      cached.number === ref.number
    );
  });
}

export function clearCache(opts: { prRef?: PrRef; clearAll?: boolean; rootOverride?: string }): { removedFiles: number } {
  const root = opts.rootOverride ?? CACHE_ROOT;
  let target: string;
  if (opts.clearAll) {
    target = root;
  } else if (opts.prRef) {
    if (opts.prRef.provider === 'azuredevops' && opts.prRef.project === undefined) {
      const providerRoot = join(root, opts.prRef.provider);
      if (!existsSync(providerRoot)) return { removedFiles: 0 };
      const prefix = `${safeOwner(opts.prRef)}__`;
      const suffix = `__${safeSegment(opts.prRef.repo)}`;
      const targets = readdirSync(providerRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.endsWith(suffix))
        .map((entry) => join(providerRoot, entry.name, String(opts.prRef!.number)))
        .filter((candidate) => cacheTargetMatchesRef(candidate, opts.prRef!));
      let removedFiles = 0;
      for (const candidate of targets) {
        removedFiles += walk(candidate).length;
        rmSync(candidate, { recursive: true, force: true });
      }
      return { removedFiles };
    }
    target = join(root, opts.prRef.provider, gatherCacheScope(opts.prRef), String(opts.prRef.number));
  } else {
    return { removedFiles: 0 };
  }
  if (!existsSync(target)) return { removedFiles: 0 };
  const count = walk(target).length;
  rmSync(target, { recursive: true, force: true });
  return { removedFiles: count };
}
