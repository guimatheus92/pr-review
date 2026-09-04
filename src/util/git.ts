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

/** Per-call memo: one `.git` lookup per directory, one ls-files + status pair per repository. */
export interface ProvenanceCache {
  roots: Map<string, string | null>;
  repos: Map<string, RepoState | null>;
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

/** Throws when git fails: a failure must never read as an empty (clean) tree. */
function gitZ(root: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
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

/**
 * Where a file stands in the repository that owns it. Content outside the
 * reviewed checkout is trusted only when `clean`: on Windows, `git checkout`
 * writes THROUGH an NTFS junction into a shared directory, so an untracked or
 * modified file there may be what a checkout just planted. `ownedDir` extends
 * the check to every entry of a directory, for a `SKILL.md` that owns its
 * siblings (a `SKILL.md` at the repository root owns the whole tree).
 */
export function gitProvenance(file: string, cache: ProvenanceCache, ownedDir?: string): GitProvenance {
  const dir = dirname(file);
  let root = cache.roots.get(dir);
  if (root === undefined) {
    root = findRepoRoot(dir);
    cache.roots.set(dir, root);
  }
  if (root === null) return 'no-repo';
  let repo = cache.repos.get(root);
  if (repo === undefined) {
    try {
      repo = { tracked: new Set(gitZ(root, ['ls-files', '-z']).map(foldPath)), dirty: dirtyPaths(root) };
    } catch {
      repo = null; // git missing, or a repository it cannot read — nothing here is verifiable
    }
    cache.repos.set(root, repo);
  }
  if (repo === null) return 'error';
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
