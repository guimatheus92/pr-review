import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePr } from '../providers/index.js';
import type { GatherOutput } from '../types.js';
import { applyDiffExclusions, summarizeExclusions } from '../dispatch/diff-filter.js';
import { lastCommentIdFrom } from '../cache/keys.js';
import { readGatherCache, writeGatherCache } from '../cache/store.js';
import type { PrProvider } from '../providers/types.js';

interface GatherCmdOptions {
  prUrl: string;
  outPath?: string;
  extraExcludes?: string[];
  useCache?: boolean;
  /** Test seam; production resolves the provider from prUrl. */
  provider?: PrProvider;
  /** Test seams; production reads and writes the on-disk gather cache. */
  readGatherCacheFn?: typeof readGatherCache;
  writeGatherCacheFn?: typeof writeGatherCache;
}

export function refreshCachedGatherIdentity(gather: GatherOutput, ref: GatherOutput['pr']): GatherOutput {
  return { ...gather, pr: { ...gather.pr, ...ref } };
}

export async function runGather(opts: GatherCmdOptions): Promise<GatherOutput> {
  const useCache = opts.useCache ?? true;
  const { provider, ref } = resolvePr(opts.prUrl, undefined, opts.provider);
  const readCache = opts.readGatherCacheFn ?? readGatherCache;
  const writeCache = opts.writeGatherCacheFn ?? writeGatherCache;

  process.stderr.write(`[gather] fetching metadata for ${ref.provider} PR #${ref.number}…\n`);
  const [metadata, existingComments] = await Promise.all([
    provider.fetchMetadata(ref),
    provider.fetchExistingComments(ref),
  ]);

  const cacheAllowed = useCache && (ref.provider !== 'azuredevops' || ref.project !== undefined);
  if (useCache && !cacheAllowed) {
    process.stderr.write('[gather] ADO project could not be resolved — bypassing gather cache to avoid cross-project reuse\n');
  }

  if (cacheAllowed) {
    const lastCommentId = lastCommentIdFrom(existingComments);
    const hit = readCache(ref, metadata.headSha, lastCommentId);
    if (hit) {
      const legacyFiltered = hit.data.changedFiles.some((file) => file.excluded || file.excludedReason);
      if (!legacyFiltered) {
        const cachedRaw = refreshCachedGatherIdentity(hit.data, ref);
        const cached = { ...cachedRaw, changedFiles: applyDiffExclusions(cachedRaw.changedFiles, opts.extraExcludes) };
        process.stderr.write(
          `[gather] cache hit (age ${(hit.ageMs / 1000).toFixed(1)}s) — ${hit.path}\n`,
        );
        if (opts.outPath) {
          mkdirSync(dirname(opts.outPath), { recursive: true });
          writeFileSync(opts.outPath, JSON.stringify(cached, null, 2), 'utf8');
        }
        return cached;
      }
      process.stderr.write('[gather] filtered legacy cache entry ignored — refetching raw changed files\n');
    }
  }

  const [changedFilesRaw, fullDiff] = await Promise.all([
    provider.fetchChangedFiles(ref),
    provider.fetchFullDiff(ref),
  ]);

  const changedFiles = applyDiffExclusions(changedFilesRaw, opts.extraExcludes);
  const exc = summarizeExclusions(changedFiles);
  process.stderr.write(
    `[gather] ${exc.kept} files in-scope, ${exc.excluded} excluded; ${existingComments.length} existing comments.\n`,
  );

  const out: GatherOutput = {
    pr: ref,
    metadata,
    changedFiles,
    fullDiff,
    existingComments,
    gatheredAt: new Date().toISOString(),
  };

  if (cacheAllowed) {
    try {
      const cachePath = writeCache({ ...out, changedFiles: changedFilesRaw });
      process.stderr.write(`[gather] cached at ${cachePath}\n`);
    } catch (err) {
      process.stderr.write(`[gather] cache write failed: ${(err as Error).message}\n`);
    }
  }

  if (opts.outPath) {
    mkdirSync(dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, JSON.stringify(out, null, 2), 'utf8');
    process.stderr.write(`[gather] wrote ${opts.outPath}\n`);
  }

  return out;
}
