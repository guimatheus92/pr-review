import { execFileSync } from 'node:child_process';
import { languageTags, type LinguistIndex } from './linguist.js';
import { ecosystemTags, isManifest, parseManifest, readDependencyTags } from './manifests.js';

export interface StackInfo {
  /** Language tags from Linguist over the changed paths (names + aliases, lowercase). */
  languages: string[];
  /** Dependency names read from the checkout's manifests + the PR's own manifest diffs (lowercase). */
  dependencies: string[];
  /** languages ∪ dependencies ∪ manifest-ecosystem tags — what skills match against. */
  tags: string[];
  /** Human-readable reasons for anything skipped. */
  notes: string[];
  /** True when the checkout's git origin IS the PR's repo — gates reading its skills/manifests. */
  cwdIsPrRepo: boolean;
}

/** Origin URLs can embed credentials (https://user:token@host/…) — never log them raw. */
export function maskUrl(u: string | null): string | null {
  return u === null ? null : u.replace(/\/\/[^@/]+@/, '//***@');
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

/** Manifests live at the repo root — resolve it so a run from a subdirectory still finds them. */
function defaultGitToplevel(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

export function detectStack(
  changedFiles: { path: string; patch?: string }[],
  opts: {
    linguist: LinguistIndex | null;
    cwd?: string;
    pr?: { owner: string; repo: string };
    gitRemote?: (cwd: string) => string | null;
    gitToplevel?: (cwd: string) => string | null;
  },
): StackInfo {
  const notes: string[] = [];
  const languages = new Set<string>();
  if (opts.linguist) {
    for (const f of changedFiles) {
      for (const t of languageTags(opts.linguist, f.path)) languages.add(t);
    }
  } else {
    notes.push('Linguist data unavailable — language tags skipped');
  }

  const dependencies = new Set<string>();
  const ecosystems = new Set<string>();

  // The PR's OWN manifest diffs: a PR that adds a framework should get that
  // framework's passes even though the local checkout doesn't have it yet.
  for (const f of changedFiles) {
    const base = f.path.replace(/\\/g, '/').split('/').pop()!;
    if (!isManifest(base) || !f.patch) continue;
    for (const t of ecosystemTags(base)) ecosystems.add(t);
    const added = f.patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1))
      .join('\n');
    if (/\.json$/i.test(base)) {
      // Added JSON lines are a fragment JSON.parse cannot read — extract
      // `"name": "version"` pairs (section keys have object values, so they
      // don't match).
      for (const m of added.matchAll(/"(@?[a-z0-9][\w./-]*)"\s*:\s*"/gi)) {
        const dep = m[1]!.toLowerCase();
        dependencies.add(dep);
        if (dep.includes('/')) dependencies.add(dep.replace(/^@/, '').split('/')[0]!);
      }
    } else {
      for (const dep of parseManifest(base, added)) dependencies.add(dep);
    }
  }

  let cwdIsPrRepo = false;
  if (opts.cwd && opts.pr) {
    const origin = (opts.gitRemote ?? defaultGitRemote)(opts.cwd);
    if (cwdMatchesPr(origin, opts.pr.owner, opts.pr.repo)) {
      cwdIsPrRepo = true;
      const root = (opts.gitToplevel ?? defaultGitToplevel)(opts.cwd) ?? opts.cwd;
      const dep = readDependencyTags(root);
      for (const d of dep.dependencies) dependencies.add(d);
      for (const e of dep.ecosystems) ecosystems.add(e);
    } else {
      notes.push(
        `cwd is not a checkout of ${opts.pr.owner}/${opts.pr.repo} (origin: ${maskUrl(origin) ?? 'none'}) — its manifests and skills are not used`,
      );
    }
  }

  const deps = [...dependencies].sort();
  const tags = [...new Set([...languages, ...deps, ...ecosystems])].sort();
  return { languages: [...languages].sort(), dependencies: deps, tags, notes, cwdIsPrRepo };
}
