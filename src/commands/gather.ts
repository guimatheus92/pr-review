import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePr } from '../providers/index.js';
import type { ChangedFile, GatherOutput, PrMetadata, PrRef } from '../types.js';
import { applyDiffExclusions, summarizeExclusions } from '../dispatch/diff-filter.js';
import { lastCommentIdFrom } from '../cache/keys.js';
import { readGatherCache, writeGatherCache } from '../cache/store.js';
import type { PrProvider } from '../providers/types.js';
import pLimit from 'p-limit';
import { cwdMatchesPr, defaultGitRemote } from '../stack/detect.js';
import { diffLines } from '../util/diff-lines.js';
import { gitOut, gitTopLevel, gitZ } from '../util/git.js';

const PATCH_CONCURRENCY = 8;

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
  /** Checkout used to complete a truncated provider file list from git; review passes its repo root. Default: process.cwd(). */
  cwd?: string;
}

/**
 * A provider list of any other length than the provider's own count — or one
 * the provider declares truncated — is unknown, never complete: it feeds every
 * trust gate keyed on changed paths, where a missing path reads as "unchanged".
 */
function listIsIncomplete(files: ChangedFile[], m: PrMetadata): boolean {
  return m.changedFileListTruncated === true || (m.changedFileCount !== undefined && files.length !== m.changedFileCount);
}

function truncationSummary(files: ChangedFile[], ref: PrRef, m: PrMetadata): string {
  return m.changedFileListTruncated
    ? `${ref.provider} listed ${files.length} changed files and reports the list as truncated (its stored diff overflowed)`
    : `${ref.provider} listed ${files.length} of ${m.changedFileCount} changed files — file list truncated`;
}

/** GitHub's base.sha is the base-branch TIP (not an ancestor of head), so both refs are named; GitLab's base_sha is the merge base, reachable from the MR head. */
function fetchHint(ref: PrRef, m: PrMetadata): string {
  if (ref.provider === 'github') return `git fetch origin ${m.baseBranch} refs/pull/${ref.number}/head`;
  if (ref.provider === 'gitlab') return `git fetch origin refs/merge-requests/${ref.number}/head`;
  return `git fetch origin ${m.baseBranch} ${m.headBranch}`;
}

function refusal(files: ChangedFile[], ref: PrRef, m: PrMetadata, reason: string): Error {
  return new Error(
    `${truncationSummary(files, ref, m)}; ${reason}. pr-review completes the list from git only from a checkout of ${ref.owner}/${ref.repo} (remote origin) that already has base ${m.baseSha || '<unknown>'} and head ${m.headSha}: run '${fetchHint(ref, m)}' there and retry (pr-review never fetches into your checkout)`,
  );
}

/**
 * Union the provider's truncated list with the checkout's own view of the same
 * range. Read-only by construction: it never fetches, checks out or writes a
 * ref — a commit that is absent is the user's `git fetch` to run, named in the
 * error. Plumbing (`diff-tree`) rather than porcelain so the reviewer's diff.*
 * config (external diff, textconv, relative paths, submodule display) cannot
 * reshape the list; `-z` so non-ASCII paths arrive raw instead of C-quoted.
 */
async function completeFromGit(files: ChangedFile[], ref: PrRef, m: PrMetadata, cwd: string): Promise<ChangedFile[]> {
  const refuse = (reason: string): Error => refusal(files, ref, m, reason);
  const root = gitTopLevel(cwd);
  if (!root || !cwdMatchesPr(defaultGitRemote(root), ref.owner, ref.repo, ref.project, ref)) {
    throw refuse('the current directory is not a checkout of the repository under review');
  }
  if (!m.baseSha || !m.headSha) {
    throw refuse('the provider has not reported both base and head commits yet (a fresh PR may still be computing its diff) — retry shortly');
  }
  for (const [name, sha] of [['base', m.baseSha], ['head', m.headSha]] as const) {
    try {
      gitOut(root, ['cat-file', '-e', sha + '^{commit}']);
    } catch {
      throw refuse(name + ' commit ' + sha + ' is not in this checkout');
    }
  }
  if (gitOut(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
    throw refuse('this checkout is shallow, so its merge base cannot be trusted');
  }
  // One merge base, or git and the provider may have diffed against different
  // ancestors — and the branch under review controls which files that hides.
  const bases = gitOut(root, ['merge-base', '--all', m.baseSha, m.headSha]).split('\n').map((line) => line.trim()).filter(Boolean);
  if (bases.length !== 1) {
    throw refuse('base and head have ' + bases.length + " merge bases (criss-cross history), so git cannot reproduce the provider's diff");
  }
  const mergeBase = bases[0]!;

  const known = new Set(files.map((file) => file.path));
  const missing: ChangedFile[] = [];
  // -z tokens: `X\0path\0`; a rename or copy is `R100\0old\0new\0` (same shape gitProvenance parses).
  const tokens = gitZ(root, ['diff-tree', '-r', '-M', '-z', '--name-status', mergeBase, m.headSha]);
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i]![0];
    const previousPath = code === 'R' || code === 'C' ? tokens[i + 1] : undefined;
    const path = previousPath ? tokens[i + 2]! : tokens[i + 1]!;
    i += previousPath ? 3 : 2;
    if (known.has(path)) continue; // the provider's entry, with its own patch, wins
    const status: ChangedFile['status'] = code === 'A' || code === 'C' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
    missing.push({ path, status, ...(previousPath ? { previousPath } : {}), additions: 0, deletions: 0 });
  }

  // ponytail: one spawn per missing file (~4 ms effective, 8 wide). A single
  // pathspec-less diff would need a `diff --git` header parser (headers stay
  // C-quoted even under -z) and a Windows argv budget; revisit only if a real
  // PR makes this the slow step.
  const limit = pLimit(PATCH_CONCURRENCY);
  await Promise.all(
    missing.map((file) =>
      limit(async () => {
        // Both sides of a rename, or -M sees a bare add; --literal-pathspecs so a
        // `*` or `[` in a file name is a name, not a glob.
        const out = gitOut(root, [
          '--literal-pathspecs', 'diff-tree', '-r', '-M', '-p', '--no-color', mergeBase, m.headSha, '--',
          file.path, ...(file.previousPath ? [file.previousPath] : []),
        ]);
        const hunk = out.search(/^@@ /m);
        if (hunk < 0) return; // binary, pure rename, mode-only, or a -diff attribute: patch-less, as providers report binaries
        file.patch = out.slice(hunk).trimEnd();
        for (const line of diffLines(file.patch)) {
          if (line.startsWith('@@')) continue;
          if (line.startsWith('+')) file.additions++;
          else if (line.startsWith('-')) file.deletions++;
        }
      }),
    ),
  );
  process.stderr.write('[gather] ' + truncationSummary(files, ref, m) + '; completed ' + missing.length + ' file(s) from git at ' + root + '\n');
  return [...files, ...missing];
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
      // An entry without the marker predates the completeness gate (0.6–0.10 cached
      // ADO lists cut at 100 files raw) under a key the upgrade does not rotate.
      if (!legacyFiltered && hit.data.changedFilesComplete === true) {
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
      process.stderr.write(
        legacyFiltered
          ? '[gather] filtered legacy cache entry ignored — refetching raw changed files\n'
          : '[gather] cache entry predates the file-list completeness check — refetching changed files\n',
      );
    }
  }

  const [changedFilesProvider, fullDiff] = await Promise.all([
    provider.fetchChangedFiles(ref),
    provider.fetchFullDiff(ref),
  ]);
  // A short list is completed from the checkout or refused — never reviewed, never cached.
  const changedFilesRaw = listIsIncomplete(changedFilesProvider, metadata)
    ? await completeFromGit(changedFilesProvider, ref, metadata, opts.cwd ?? process.cwd())
    : changedFilesProvider;

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
    changedFilesComplete: true,
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
