import { matchesAny } from '../util/globs.js';
import type { ChangedFile, ChangedFilesOptions } from '../types.js';

/**
 * The review guards. They live beside `applyDiffExclusions` rather than in
 * `src/commands/review.ts` because three callers need them and one of those is
 * `src/commands/gather.ts` — which `review.ts` imports, so the constants cannot
 * live there without a cycle.
 *
 * `MAX_PATCH_BYTES` is a byte budget expressed in decimal millions; the message
 * that reports it divides by 1024², so 2_000_000 renders as "1.9 MB".
 */
export const MAX_FILES_GUARD = 500;
export const MAX_PATCH_BYTES = 2_000_000;

export const DEFAULT_EXCLUDES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/go.sum',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/.terraform.lock.hcl',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/vendor/**',
  '**/__generated__/**',
  '**/generated/**',
  '**/*.generated.*',
  '**/*.pb.go',
  '**/*.pb.ts',
  '**/*.designer.cs',
  '**/AssemblyInfo.cs',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/*.{png,jpg,jpeg,gif,svg,ico,pdf,zip,tar,gz,bin,exe,dll,so,dylib,woff,woff2,ttf,eot}',
];

export function applyDiffExclusions(files: ChangedFile[], extraExcludes: string[] = []): ChangedFile[] {
  const patterns = [...DEFAULT_EXCLUDES, ...extraExcludes];
  return files.map((f) => {
    if (matchesAny(f.path, patterns)) {
      return { ...f, excluded: true, excludedReason: 'matched diff-exclusion glob', patch: undefined };
    }
    return f;
  });
}

/** The answer `patchPolicy` returns: per file, globally, and the count it was decided on. */
export interface PatchPolicy {
  /** Can this file's content still reach a review pass? */
  wants(path: string): boolean;
  /** True when the in-scope count already exceeds the guard: no file is worth fetching. */
  omitted: boolean;
  /** In-scope count the decision was taken over — for the log line that explains the skip. */
  inScope: number;
}

/**
 * Which of these paths are worth fetching content for (INV-FETCH-04) — the one
 * question both cost sites ask: the Azure DevOps provider before spending two
 * whole-file `getItem` calls, and gather's truncated-list completion before
 * spawning a `git diff-tree -p` per missing file.
 *
 * `omitted` is the global answer: once more than `maxPatchedFiles` paths are in
 * scope the run is refused whatever the content says, so nothing is worth
 * fetching. It is deliberately computed over the SAME in-scope set the guard
 * will count — exclusions included — so the cheap path can never swallow a PR
 * the review would have accepted.
 *
 * Callers pass the complete pattern list they want applied; no defaults are
 * folded in here, so `fetchChangedFiles(ref)` with no options still fetches
 * everything and the standalone `gather` command is unchanged.
 */
export function patchPolicy(paths: string[], opts: ChangedFilesOptions = {}): PatchPolicy {
  const trusted = opts.excludes ?? [];
  // Counting uses the wider list, suppressing uses only the trusted one — see
  // ChangedFilesOptions.countOnlyExcludes. The two are NOT interchangeable.
  const counted = [...trusted, ...(opts.countOnlyExcludes ?? [])];
  const matches = (patterns: string[], path: string): boolean => patterns.length > 0 && matchesAny(path, patterns);
  const inScope = paths.reduce((n, path) => (matches(counted, path) ? n : n + 1), 0);
  const omitted = opts.maxPatchedFiles !== undefined && inScope > opts.maxPatchedFiles;
  return {
    omitted,
    inScope,
    wants: (path: string) => !omitted && !matches(trusted, path),
  };
}

export function summarizeExclusions(files: ChangedFile[]): { kept: number; excluded: number; excludedNames: string[] } {
  const kept = files.filter((f) => !f.excluded);
  const excluded = files.filter((f) => f.excluded);
  return {
    kept: kept.length,
    excluded: excluded.length,
    excludedNames: excluded.map((f) => f.path),
  };
}
