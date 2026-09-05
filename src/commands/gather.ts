import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePr } from '../providers/index.js';
import type { ChangedFile, GatherOutput, PrMetadata, PrRef } from '../types.js';
import { applyDiffExclusions, summarizeExclusions } from '../dispatch/diff-filter.js';
import { lastCommentIdFrom } from '../cache/keys.js';
import { readGatherCache, writeGatherCache } from '../cache/store.js';
import type { PrProvider } from '../providers/types.js';
import pLimit from 'p-limit';
import { cwdMatchesPr } from '../stack/detect.js';
import { countChangedLines } from '../util/diff-lines.js';
import { gitOut, gitOutAsync, gitTopLevel, gitZ } from '../util/git.js';

const PATCH_CONCURRENCY = 8;
const HEX_ID = /^[0-9a-f]{7,64}$/i;
const GIT_STATUS: Record<string, ChangedFile['status']> = { A: 'added', C: 'added', D: 'deleted', R: 'renamed' };

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
async function completeFromGit(files: ChangedFile[], ref: PrRef, m: PrMetadata, cwd: string): Promise<ChangedFile[]> {
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

  // ponytail: one async spawn per missing file, 8 wide. A single pathspec-less
  // diff would need a `diff --git` header parser (headers stay C-quoted even
  // under -z) and a Windows argv budget; revisit only if a real PR makes this
  // the slow step.
  const limit = pLimit(PATCH_CONCURRENCY);
  try {
    await Promise.all(
      missing.map((file) =>
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
  const patchless = missing.filter((file) => file.patch === undefined).length;
  process.stderr.write(
    '[gather] ' + truncationSummary(files, ref, m) + '; completed ' + missing.length + ' file(s) from git at ' + root +
      (patchless ? ' (' + patchless + ' without a patch: binary, pure rename, mode-only or a -diff attribute)' : '') + '\n',
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
  // Incomplete (see listIsIncomplete): completed from the checkout or refused — never reviewed as-is, never cached.
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
