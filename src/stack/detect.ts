import { execFileSync } from 'node:child_process';
import { languageTags, type LinguistIndex } from './linguist.js';
import { readDependencyTags } from './manifests.js';

export interface StackInfo {
  /** Language tags from Linguist over the changed paths (names + aliases, lowercase). */
  languages: string[];
  /** Dependency names read from the checkout's manifests (lowercase). */
  dependencies: string[];
  /** languages ∪ dependencies ∪ manifest-ecosystem tags — what skills match against. */
  tags: string[];
  /** Human-readable reasons for anything skipped. */
  notes: string[];
}

/**
 * Only read the checkout's manifests when the checkout IS the PR's repo:
 * origin must end in the repo name and contain every owner segment (GitLab
 * nested namespaces put '/' in owner; ADO origins carry org/project/_git).
 */
export function cwdMatchesPr(originUrl: string | null, owner: string, repo: string): boolean {
  if (!originUrl) return false;
  const url = originUrl.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  const segs = url.split(/[/:]/).filter(Boolean);
  if (segs.length === 0) return false;
  const ownerSegs = owner.toLowerCase().split('/').filter(Boolean);
  return segs[segs.length - 1] === repo.toLowerCase() && ownerSegs.every((s) => segs.includes(s));
}

function defaultGitRemote(cwd: string): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export function detectStack(
  changedPaths: string[],
  opts: {
    linguist: LinguistIndex | null;
    cwd?: string;
    pr?: { owner: string; repo: string };
    gitRemote?: (cwd: string) => string | null;
  },
): StackInfo {
  const notes: string[] = [];
  const languages = new Set<string>();
  if (opts.linguist) {
    for (const p of changedPaths) {
      for (const t of languageTags(opts.linguist, p)) languages.add(t);
    }
  } else {
    notes.push('Linguist data unavailable — language tags skipped');
  }

  let dependencies: string[] = [];
  let ecosystems: string[] = [];
  if (opts.cwd && opts.pr) {
    const origin = (opts.gitRemote ?? defaultGitRemote)(opts.cwd);
    if (cwdMatchesPr(origin, opts.pr.owner, opts.pr.repo)) {
      const dep = readDependencyTags(opts.cwd);
      dependencies = dep.dependencies;
      ecosystems = dep.ecosystems;
    } else {
      notes.push(
        `cwd is not a checkout of ${opts.pr.owner}/${opts.pr.repo} (origin: ${origin ?? 'none'}) — dependency tags skipped`,
      );
    }
  }

  const tags = [...new Set([...languages, ...dependencies, ...ecosystems])].sort();
  return { languages: [...languages].sort(), dependencies, tags, notes };
}
