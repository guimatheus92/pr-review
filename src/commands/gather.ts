import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { detectProvider } from '../providers/index.js';
import type { GatherOutput } from '../types.js';
import { applyDiffExclusions, summarizeExclusions } from '../dispatch/diff-filter.js';
import { readGatherCache, writeGatherCache } from '../cache/store.js';

interface GatherCmdOptions {
  prUrl: string;
  outPath?: string;
  extraExcludes?: string[];
  useCache?: boolean;
}

export async function runGather(opts: GatherCmdOptions): Promise<GatherOutput> {
  const useCache = opts.useCache ?? true;
  const provider = detectProvider(opts.prUrl);
  const ref = provider.parseUrl(opts.prUrl);
  if (!ref) {
    throw new Error(`Failed to parse PR URL: ${opts.prUrl}`);
  }

  process.stderr.write(`[gather] fetching metadata for ${ref.provider} PR #${ref.number}…\n`);
  const [metadata, existingComments] = await Promise.all([
    provider.fetchMetadata(ref),
    provider.fetchExistingComments(ref),
  ]);

  if (useCache) {
    const sortedIds = existingComments
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const lastCommentId = sortedIds.length > 0 ? sortedIds[sortedIds.length - 1]!.id : 'none';

    const hit = readGatherCache(ref, metadata.headSha, lastCommentId);
    if (hit) {
      process.stderr.write(
        `[gather] cache hit (age ${(hit.ageMs / 1000).toFixed(1)}s) — ${hit.path}\n`,
      );
      if (opts.outPath) {
        mkdirSync(dirname(opts.outPath), { recursive: true });
        writeFileSync(opts.outPath, JSON.stringify(hit.data, null, 2), 'utf8');
      }
      return hit.data;
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

  if (useCache) {
    try {
      const cachePath = writeGatherCache(out);
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
