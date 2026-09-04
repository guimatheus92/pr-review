import { execFileSync } from 'node:child_process';
import { dirname, relative } from 'node:path';
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

export type GitProvenance = 'clean' | 'dirty' | 'untracked' | 'no-repo';

interface RepoState {
  tracked: Set<string>;
  dirty: Set<string>;
}

/** Per-call memo: two spawns per owning repository, not per file. */
export interface ProvenanceCache {
  roots: Map<string, string | null>;
  repos: Map<string, RepoState>;
}

export function newProvenanceCache(): ProvenanceCache {
  return { roots: new Map(), repos: new Map() };
}

function gitZ(root: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** `status --porcelain -z`: `XY path`, renames/copies carry the old path as the next token. */
function dirtyPaths(root: string): Set<string> {
  const out = new Set<string>();
  const tokens = gitZ(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!;
    out.add(foldPath(entry.slice(3)));
    if (/^[RC]|^.[RC]/.test(entry.slice(0, 2))) i++;
  }
  return out;
}

/**
 * Where a file stands in the repository that owns it. `clean` means committed and
 * unmodified — the only state in which content outside the reviewed checkout is
 * provably not something a checkout just wrote (on Windows, `git checkout` writes
 * THROUGH an NTFS junction into the shared directory). `ownedDir` extends the check
 * to every entry of a directory, for a `SKILL.md` that owns its siblings.
 */
export function gitProvenance(file: string, cache: ProvenanceCache, ownedDir?: string): GitProvenance {
  const dir = dirname(file);
  let root = cache.roots.get(dir);
  if (root === undefined) {
    root = gitTopLevel(dir);
    cache.roots.set(dir, root);
  }
  if (root === null) return 'no-repo';
  let repo = cache.repos.get(root);
  if (repo === undefined) {
    repo = { tracked: new Set(gitZ(root, ['ls-files', '-z']).map(foldPath)), dirty: dirtyPaths(root) };
    cache.repos.set(root, repo);
  }
  const rel = foldPath(relative(root, file));
  if (!repo.tracked.has(rel)) return 'untracked';
  if (repo.dirty.has(rel)) return 'dirty';
  if (ownedDir) {
    const prefix = foldPath(relative(root, ownedDir)) + '/';
    for (const path of repo.dirty) if (path.startsWith(prefix)) return 'dirty';
  }
  return 'clean';
}
