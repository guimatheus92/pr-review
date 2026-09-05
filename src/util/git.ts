import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { foldPath } from './realpath.js';

export function gitTopLevel(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `clean` is the only state in which a file is provably what its repository
 * committed. `error` is a repository git could not read (or no git at all):
 * unverifiable, so callers must treat it like `dirty`, never like `clean`.
 */
export type GitProvenance = 'clean' | 'dirty' | 'untracked' | 'no-repo' | 'error';

interface RepoState {
  tracked: Set<string>;
  dirty: Set<string>;
}

/** Per-review memo: one `.git` lookup per directory, one ls-files + status pair per repository. */
export interface ProvenanceCache {
  roots: Map<string, string | null>;
  repos: Map<string, RepoState | { error: string }>;
}

export function newProvenanceCache(): ProvenanceCache {
  return { roots: new Map(), repos: new Map() };
}

/** Nearest ancestor holding a `.git` entry (a dir, or the file a worktree/submodule carries) — no git spawn, so "no repository" is a filesystem fact, not a failed command. */
function findRepoRoot(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return null;
  }
}

/**
 * Run git in `root` and return stdout. Throws when git fails or hangs: a failure
 * must never read as empty output (an empty tree, an empty diff). Read-only by
 * convention — nothing in pr-review fetches, checks out or writes a ref in the
 * reviewer's checkout.
 */
export function gitOut(root: string, args: string[]): string {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
}

/** NUL-split stdout for `-z` listings: paths arrive raw, never C-quoted. */
export function gitZ(root: string, args: string[]): string[] {
  return gitOut(root, args).split('\0').filter(Boolean);
}

/** `status --porcelain -z`: `XY path`; a rename/copy carries the old path as the next token. */
function dirtyPaths(root: string): Set<string> {
  const out = new Set<string>();
  const tokens = gitZ(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    out.add(foldPath(entry.slice(3)));
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  return out;
}

function repoState(root: string, cache: ProvenanceCache): RepoState | { error: string } {
  let repo = cache.repos.get(root);
  if (repo === undefined) {
    try {
      repo = { tracked: new Set(gitZ(root, ['ls-files', '-z']).map(foldPath)), dirty: dirtyPaths(root) };
    } catch (err) {
      // git missing, or a repository it cannot read — nothing here is verifiable
      repo = { error: String((err as Error).message ?? err).split('\n')[0] ?? 'git failed' };
    }
    cache.repos.set(root, repo);
  }
  return repo;
}

/**
 * Where a file stands in the repository that owns it. Content outside the
 * reviewed checkout is trusted only when `clean`: on Windows, `git checkout`
 * writes THROUGH an NTFS junction into a shared directory, so an untracked or
 * modified file there may be what a checkout just planted. `ownedDir` extends
 * the check to every entry git reports under a directory, for a `SKILL.md`
 * that owns its siblings (a `SKILL.md` at the repository root owns the whole tree).
 */
export function gitProvenance(file: string, cache: ProvenanceCache, ownedDir?: string): GitProvenance {
  const dir = dirname(file);
  let root = cache.roots.get(dir);
  if (root === undefined) {
    root = findRepoRoot(dir);
    cache.roots.set(dir, root);
  }
  if (root === null) return 'no-repo';
  const repo = repoState(root, cache);
  if ('error' in repo) return 'error';
  const rel = foldPath(relative(root, file));
  if (!repo.tracked.has(rel)) return 'untracked';
  if (repo.dirty.has(rel)) return 'dirty';
  if (ownedDir) {
    const owned = foldPath(relative(root, ownedDir));
    const prefix = owned === '' ? '' : owned + '/';
    for (const path of repo.dirty) if (path.startsWith(prefix)) return 'dirty';
  }
  return 'clean';
}

/** The git failure behind an `error` state, for the skip reason. */
export function gitProvenanceError(file: string, cache: ProvenanceCache): string | undefined {
  const root = cache.roots.get(dirname(file));
  if (!root) return undefined;
  const repo = cache.repos.get(root);
  return repo && 'error' in repo ? repo.error : undefined;
}
