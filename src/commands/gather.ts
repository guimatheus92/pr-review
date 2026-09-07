import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePr } from '../providers/index.js';
import type { ChangedFile, ChangedFilesOptions, GatherOutput, PrMetadata, PrRef } from '../types.js';
import {
  applyDiffExclusions,
  DEFAULT_EXCLUDES,
  MAX_FILES_GUARD,
  patchPolicy,
  summarizeExclusions,
} from '../dispatch/diff-filter.js';
import { changesRepoConfig } from '../config.js';
import { lastCommentIdFrom } from '../cache/keys.js';
import { readGatherCache, writeGatherCache } from '../cache/store.js';
import type { PrProvider } from '../providers/types.js';
import pLimit from 'p-limit';
import { cwdMatchesPr } from '../stack/detect.js';
import { countChangedLines } from '../util/diff-lines.js';
import { gitOut, gitOutAsync, gitTopLevel, gitZ } from '../util/git.js';

const PATCH_CONCURRENCY = 8;
const HEX_ID = /^[0-9a-f]{7,64}$/i;
/** Exported so `tests/changed-file-status.test.ts` can list this producer's vocabulary alongside the three providers'. End-to-end coverage of the letters git really emits lives in `tests/gather-cache.test.ts`. */
export const GIT_STATUS: Record<string, ChangedFile['status']> = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' };

/** The copy-paste hint quotes a ref only when it must: a refname may carry shell metacharacters (dollar, semicolon, pipe), rarely a quote; a plain one stays bare so the command also pastes into cmd.exe. */
const PLAIN_REF = /^[A-Za-z0-9._/-]+$/;
function shellQuote(ref: string): string {
  if (PLAIN_REF.test(ref)) return ref;
  return "'" + ref.split("'").join("'\\''") + "'";
}

/** What git said, for a refusal: stderr's first line, else the signal (a timeout kill) or exit status — merge-base exits 1 in silence for unrelated histories — and only then the error's own first line. */
function gitDetail(err: unknown): string {
  const e = err as { stderr?: string; status?: number | null; signal?: string | null; killed?: boolean; message?: string };
  const line = String(e.stderr ?? '').trim().split('\n')[0];
  if (line) return line;
  if (e.signal) return 'git was killed by ' + e.signal + (e.killed ? ' (timeout)' : '');
  if (typeof e.status === 'number') return 'git exited with status ' + e.status;
  return String(e.message ?? err).split('\n')[0] ?? 'git failed';
}

/** An origin URL may embed credentials (https://user:token@host/…): never echo them into stderr or error.txt. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url.replace(/^[^@:/]+:[^@]*@/, ''); // scp-style user:secret@host:path
  }
}

interface GatherCmdOptions {
  prUrl: string;
  outPath?: string;
  extraExcludes?: string[];
  /**
   * `diff_excludes` from the checkout's own `.pr-review.yaml`, loaded
   * optimistically by the caller. Used ONLY to narrow the in-scope COUNT the
   * fetch decision is taken over (INV-FETCH-04) — never to mark a file
   * excluded, and never to decide that one file's content can be skipped.
   *
   * Without it the decision would be taken over a strictly larger set than the
   * one `earlyExitGate` finally counts, and a PR the repo's own excludes bring
   * back under the guard would be refused for being too large — a review that
   * works today.
   *
   * These globs are branch-authored, and the asymmetry is what makes that safe
   * rather than the authorship check gather cannot run here: the options have
   * to be handed to `fetchChangedFiles` *before* it returns the path list that
   * an authorship check would need. Extra excludes can only lower the count,
   * which can only make the run fetch MORE, so nothing can be suppressed.
   *
   * ponytail: the residue is cost, not correctness — a PR committing
   * `diff_excludes: ['**\/*']` drives the count to zero and gets its content
   * fetched, exactly as every PR did before #27, before being refused on the
   * real count moments later. Closing that needs the authorship answer one
   * round-trip earlier than the interface can give it; revisit if a real PR
   * ever does it. The sharper edge of the same input — a branch-authored glob
   * reaching the matcher, where `**a**a**…**b` cost 3.7 s per path — is closed
   * in `src/util/globs.ts` rather than here, because every caller wants it.
   */
  repoExcludes?: string[];
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
 * Strict comparison on purpose: GitHub is documented to report changed_files: 0
 * for a stuck diff whose list is still cut at 3000 (community discussion
 * #200746) — "shorter than the count" would call that complete.
 */
function listIsIncomplete(files: ChangedFile[], m: PrMetadata): boolean {
  return m.changedFileListTruncated === true || (m.changedFileCount !== undefined && files.length !== m.changedFileCount);
}

function truncationSummary(files: ChangedFile[], ref: PrRef, m: PrMetadata): string {
  if (m.changedFileListTruncated) {
    return `${ref.provider} listed ${files.length} changed files and reports the list as truncated (its stored diff overflowed)`;
  }
  // A longer list is a disagreement, not a truncation (see listIsIncomplete).
  return files.length < (m.changedFileCount ?? 0)
    ? `${ref.provider} listed ${files.length} of ${m.changedFileCount} changed files — file list truncated`
    : `${ref.provider} listed ${files.length} changed files against a reported count of ${m.changedFileCount} — file list disagrees with the provider's count`;
}

/** GitHub's base.sha is the base-branch TIP (not an ancestor of head), so both refs are named; GitLab's base_sha is the merge base, reachable from the MR head. */
function fetchHint(ref: PrRef, m: PrMetadata): string {
  if (ref.provider === 'github') return `git fetch origin ${shellQuote(m.baseBranch)} ${shellQuote(`refs/pull/${ref.number}/head`)}`;
  if (ref.provider === 'gitlab') return `git fetch origin ${shellQuote(`refs/merge-requests/${ref.number}/head`)}`;
  return `git fetch origin ${shellQuote(m.baseBranch)} ${shellQuote(m.headBranch)}`;
}

/** `fetchable` = a fetch in the right checkout can fix it; a structural refusal (shallow, partial, criss-cross, git failure) gets the requirements instead of a command that cannot help. */
function refusal(files: ChangedFile[], ref: PrRef, m: PrMetadata, reason: string, fetchable = true): Error {
  const where = `a full (non-shallow, non-partial) checkout of ${ref.owner}/${ref.repo} (remote origin)`;
  return new Error(
    fetchable
      ? `${truncationSummary(files, ref, m)}; ${reason}. pr-review completes the list from git only from ${where} that already has base ${m.baseSha || '<unknown>'} and head ${m.headSha}: run ${fetchHint(ref, m)} there and retry (pr-review never fetches into your checkout)`
      : `${truncationSummary(files, ref, m)}; ${reason}. pr-review completes the list from git only from ${where} whose history has a single merge base between base ${m.baseSha || '<unknown>'} and head ${m.headSha} (pr-review never fetches into your checkout)`,
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
async function completeFromGit(
  files: ChangedFile[],
  ref: PrRef,
  m: PrMetadata,
  cwd: string,
  patchOpts: ChangedFilesOptions = {},
): Promise<ChangedFile[]> {
  const refuse = (reason: string, fetchable = true): Error => refusal(files, ref, m, reason, fetchable);
  const root = gitTopLevel(cwd);
  if (!root) throw refuse('the current directory is not inside a git repository');
  let origin: string;
  try {
    origin = gitOut(root, ['remote', 'get-url', 'origin']).trim();
  } catch (err) {
    const detail = gitDetail(err);
    if (/No such remote/i.test(detail)) throw refuse("this checkout has no 'origin' remote");
    throw refuse('git could not read the origin remote (' + detail + ')', false);
  }
  if (!cwdMatchesPr(origin, ref.owner, ref.repo, ref.project, ref)) {
    throw refuse("this checkout's origin (" + redactUrl(origin) + ") is not the PR's repository " + ref.owner + '/' + ref.repo);
  }
  if (!m.baseSha || !m.headSha) {
    throw refuse('the provider has not reported both base and head commits yet (a fresh PR may still be computing its diff) — retry shortly');
  }
  for (const [name, sha] of [['base', m.baseSha], ['head', m.headSha]] as const) {
    // Provider-supplied ids become git arguments: only a hex object id gets that far.
    if (!HEX_ID.test(sha)) throw refuse(name + ' commit id ' + JSON.stringify(sha) + ' is not a hex commit id');
    try {
      gitOut(root, ['cat-file', '-e', sha + '^{commit}']);
    } catch (err) {
      throw refuse(name + ' commit ' + sha + ' is not in this checkout (' + gitDetail(err) + ')');
    }
  }
  let shallow: string;
  try {
    shallow = gitOut(root, ['rev-parse', '--is-shallow-repository']).trim();
  } catch (err) {
    throw refuse('git could not tell whether this checkout is shallow (' + gitDetail(err) + ')', false);
  }
  if (shallow !== 'false') throw refuse('this checkout is shallow, so its merge base cannot be trusted', false);
  // A partial (blobless/treeless) clone would make diff-tree -p fetch missing
  // objects from origin on demand — a network write pr-review never performs.
  let partial = '';
  try {
    partial = gitOut(root, ['config', '--get', 'extensions.partialClone']).trim();
  } catch (err) {
    // `config --get` exits 1 for an unset key and nothing else; any other failure is not a pass.
    if ((err as { status?: number | null }).status !== 1) throw refuse("git could not read this checkout's configuration (" + gitDetail(err) + ')', false);
  }
  if (partial) throw refuse('this is a partial clone (extensions.partialClone=' + partial + '): git would fetch missing objects from origin on demand, which pr-review never does', false);
  // One merge base, or git and the provider may have diffed against different
  // ancestors — and the branch under review controls which files that hides.
  let bases: string[];
  try {
    bases = gitOut(root, ['merge-base', '--all', m.baseSha, m.headSha]).split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (err) {
    throw refuse('base and head share no common ancestor, or git could not compute their merge base (' + gitDetail(err) + ')', false);
  }
  if (bases.length !== 1) {
    throw refuse('base and head have ' + bases.length + " merge bases (criss-cross history), so git cannot reproduce the provider's diff", false);
  }
  const mergeBase = bases[0]!;

  const known = new Set(files.map((file) => file.path));
  const missing: ChangedFile[] = [];
  const range = mergeBase.slice(0, 12) + '..' + m.headSha.slice(0, 12);
  // -z tokens: `X\0path\0`; a rename or copy is `R100\0old\0new\0` — old path first
  // (status --porcelain -z, which gitProvenance parses, lists the NEW path first).
  let tokens: string[];
  try {
    tokens = gitZ(root, ['diff-tree', '-r', '-M', '-z', '--name-status', mergeBase, m.headSha]);
  } catch (err) {
    throw refuse('git could not list ' + range + ' in ' + root + ' (' + gitDetail(err) + ')', false);
  }
  for (let i = 0; i < tokens.length; ) {
    const code = tokens[i]![0];
    const paired = code === 'R' || code === 'C'; // three tokens: status, old path, new path
    const previousPath = paired ? tokens[i + 1] : undefined;
    const path = tokens[i + (paired ? 2 : 1)];
    i += paired ? 3 : 2;
    if (!path || (paired && !previousPath)) throw refuse('git diff-tree -z output ended mid-record for ' + range, false);
    if (known.has(path)) continue; // the provider's entry, with its own patch, wins
    missing.push({ path, status: GIT_STATUS[code ?? ''] ?? 'modified', ...(previousPath ? { previousPath } : {}), additions: 0, deletions: 0 });
  }
  // Git can only add what this checkout sees. Against an exact count the union
  // must reach it, or the list is still unknown; "N+" carries no count to reach.
  const union = [...files, ...missing];
  if (!m.changedFileListTruncated && m.changedFileCount !== undefined && union.length < m.changedFileCount) {
    throw new Error(
      `${truncationSummary(files, ref, m)}; git completed ${missing.length} file(s) from ${root} but the list is still short (${union.length} of ${m.changedFileCount}) — this checkout does not reproduce the provider's diff, refusing to review an unknown file list`,
    );
  }

  // INV-FETCH-04: the spawn below is per missing file, so on the PRs that reach
  // this path — the truncated ones, i.e. the largest — it is thousands of git
  // processes. Skip the ones the review cannot read: excluded paths, and every
  // path once the union is already past the guard. The policy is taken over the
  // UNION, not over `missing`, because the guard counts the whole PR.
  const policy = patchPolicy(union.map((file) => file.path), patchOpts);
  const wanted = missing.filter((file) => policy.wants(file.path));
  if (policy.omitted) {
    process.stderr.write(
      `[gather] ${policy.inScope} in-scope files is past the review guard — completing paths without generating patches\n`,
    );
  }
  // ponytail: one async spawn per missing file, 8 wide. A single pathspec-less
  // diff would need a `diff --git` header parser (headers stay C-quoted even
  // under -z) and a Windows argv budget; revisit only if a real PR makes this
  // the slow step.
  const limit = pLimit(PATCH_CONCURRENCY);
  try {
    await Promise.all(
      wanted.map((file) =>
        limit(async () => {
          // Both sides of a rename, or -M sees a bare add; --literal-pathspecs so a
          // `*` or `[` in a file name is a name, not a glob.
          const out = await gitOutAsync(root, [
            '--literal-pathspecs', 'diff-tree', '-r', '-M', '-p', '--no-color', mergeBase, m.headSha, '--',
            file.path, ...(file.previousPath ? [file.previousPath] : []),
          ]);
          const hunk = out.search(/^@@ /m);
          // No hunk: binary, pure rename, mode-only, or a `-diff` attribute (possibly
          // the PR's own). The row stays, patch-less — the path is what trust reads.
          if (hunk < 0) return;
          file.patch = out.slice(hunk).trimEnd();
          const counts = countChangedLines(file.patch);
          file.additions = counts.additions;
          file.deletions = counts.deletions;
        }),
      ),
    );
  } catch (err) {
    throw refuse('git could not produce a patch for ' + range + ' in ' + root + ' (' + gitDetail(err) + ')', false);
  }
  // Only files a patch was actually attempted for can be "patchless" for the
  // documented reasons; the skipped ones have their own, already reported.
  const patchless = wanted.filter((file) => file.patch === undefined).length;
  const skipped = missing.length - wanted.length;
  process.stderr.write(
    '[gather] ' + truncationSummary(files, ref, m) + '; completed ' + missing.length + ' file(s) from git at ' + root +
      (patchless ? ' (' + patchless + ' without a patch: binary, pure rename, mode-only or a -diff attribute)' : '') +
      (skipped ? ' (' + skipped + ' path(s) listed without a patch: excluded from review or past the file guard)' : '') + '\n',
  );
  return union;
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

  // INV-FETCH-04: content is fetched only for files that can still reach a pass.
  // The provider decides per file from this; gather re-derives the same answer
  // below from the list it got back, so nothing has to be reported across the
  // interface — same inputs, same policy, one definition. Built before the cache
  // is consulted because a hit has to be checked against these same globs.
  const patchOpts: ChangedFilesOptions = {
    excludes: [...DEFAULT_EXCLUDES, ...(opts.extraExcludes ?? [])],
    countOnlyExcludes: opts.repoExcludes ?? [],
    maxPatchedFiles: MAX_FILES_GUARD,
  };

  const cacheAllowed = useCache && (ref.provider !== 'azuredevops' || ref.project !== undefined);
  if (useCache && !cacheAllowed) {
    process.stderr.write('[gather] ADO project could not be resolved — bypassing gather cache to avoid cross-project reuse\n');
  }

  if (cacheAllowed) {
    const lastCommentId = lastCommentIdFrom(existingComments);
    const hit = readCache(ref, metadata.headSha, lastCommentId);
    if (hit) {
      const legacyFiltered = hit.data.changedFiles.some((file) => file.excluded || file.excludedReason);
      // The entry withheld content for these globs; this run excludes those. The
      // key is headSha + last comment id and carries no exclusion set, so a run
      // with a NARROWER one (`pr-review gather` passes none at all) would pull
      // those rows back into scope carrying no patch — reviewed blind, with
      // nothing to signal it. Compared literally: glob subsumption is
      // undecidable, so anything but a superset refetches.
      const current = new Set(patchOpts.excludes);
      const contentStale = (hit.data.contentExcludes ?? []).some((glob) => !current.has(glob));
      // An entry without the completeness marker predates that gate (0.6–0.10 cached
      // ADO lists cut at 100 files raw) under a key the upgrade does not rotate.
      if (!legacyFiltered && !contentStale && hit.data.changedFilesComplete === true) {
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
          : contentStale
            ? '[gather] cache entry withheld content for globs this run does not exclude — refetching changed files\n'
            : '[gather] cache entry predates the file-list completeness check — refetching changed files\n',
      );
    }
  }

  const changedFilesProvider = await provider.fetchChangedFiles(ref, patchOpts);
  // Incomplete (see listIsIncomplete): completed from the checkout or refused — never reviewed as-is, never cached.
  const changedFilesRaw = listIsIncomplete(changedFilesProvider, metadata)
    ? await completeFromGit(changedFilesProvider, ref, metadata, opts.cwd ?? process.cwd(), patchOpts)
    : changedFilesProvider;

  // Recomputed on the list that came back, and now the authorship answer IS
  // available: if the PR wrote the config those globs came from, `runReview`
  // will discard them (INV-TRUST-01) and count every file, so the cache and
  // flag decisions below must be taken the same way. Too late to have saved the
  // fetch — see `repoExcludes` — but not too late to avoid storing an entry for
  // a run that is about to be refused.
  const finalOpts = changesRepoConfig(changedFilesRaw) ? { ...patchOpts, countOnlyExcludes: [] } : patchOpts;
  const policy = patchPolicy(changedFilesRaw.map((file) => file.path), finalOpts);
  // Two different questions, deliberately keyed on two different things.
  //
  // The CACHE asks "was this list assembled while withholding content?" — any
  // yes is unsafe to store, including the mixed list a truncated GitHub PR
  // produces (a handful of provider rows with patches, hundreds of git-completed
  // rows without). Restored later under a wider exclusion set, that entry looks
  // like a whole diff.
  //
  // The GATE asks the narrower "would a pass be handed paths with no content?",
  // because that is the state the byte clause below would sum to zero and wave
  // through — the same condition INV-FETCH-02 grades in `verify`. A provider
  // that ships patches inside its listing response withheld nothing, so it is
  // refused by the plain file-count clause, with an accurate message.
  const patchesOmitted = policy.omitted && !changedFilesRaw.some((file) => file.patch !== undefined);
  // Did an excluded path actually come back without its content? That is what
  // makes the cache entry conditional on the exclusion set — see contentExcludes.
  // A deleted file never has a patch anywhere, so it proves nothing here.
  const contentWithheld = changedFilesRaw.some(
    (file) => file.status !== 'deleted' && file.patch === undefined && !policy.wants(file.path),
  );
  const changedFiles = applyDiffExclusions(changedFilesRaw, opts.extraExcludes);
  const exc = summarizeExclusions(changedFiles);
  process.stderr.write(
    `[gather] ${exc.kept} files in-scope, ${exc.excluded} excluded; ${existingComments.length} existing comments.\n`,
  );

  const out: GatherOutput = {
    pr: ref,
    metadata,
    changedFiles,
    existingComments,
    gatheredAt: new Date().toISOString(),
    changedFilesComplete: true,
    ...(patchesOmitted ? { patchesOmitted: true as const } : {}),
    // Recorded only when content really was withheld for an excluded path.
    // Recording it unconditionally would invalidate every GitHub and GitLab
    // entry on any change to the exclude set, for rows that carry their patch
    // regardless — the saving does not exist there, so neither should the cost.
    ...(contentWithheld ? { contentExcludes: patchOpts.excludes ?? [] } : {}),
  };

  // Same discipline as changedFilesComplete: a list that could not be assembled
  // in full is never stored as if it were.
  if (cacheAllowed && !policy.omitted) {
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
