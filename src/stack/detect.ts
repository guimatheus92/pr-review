import { execFileSync } from 'node:child_process';
import { languageTags, type LinguistIndex } from './linguist.js';
import {
  dependencyNameTokens,
  ecosystemTags,
  isManifest,
  parseManifest,
  parseManifestDependencyGroups,
  parseManifestTokens,
  parseJsonDependencyPatch,
  readDependencyTags,
} from './manifests.js';
import { canonicalPrAuthority, canonicalRemoteAuthority } from '../providers/identity.js';
import type { PrRef } from '../types.js';

export interface StackInfo {
  /** Canonical language names from Linguist over the changed paths. */
  languages: string[];
  /** Dependency names read from the checkout's manifests + the PR's own manifest diffs (lowercase). */
  dependencies: string[];
  /** Tokens derived from dependency names, kept separate so selection can distinguish package evidence. */
  dependencyTokens: string[];
  /** Per-package token groups used to prevent unrelated dependencies composing a product identity. */
  dependencyGroups: { dependency: string; tokens: string[] }[];
  /** Manifest-kind ecosystem tags such as dotnet, nuget, node, and npm. */
  ecosystems: string[];
  /** languages ∪ dependencies ∪ manifest-ecosystem tags — what skills match against. */
  tags: string[];
  /** Human-readable reasons for anything skipped. */
  notes: string[];
  /** True when the checkout's git origin IS the PR's repo — gates reading its skills/manifests. */
  cwdIsPrRepo: boolean;
}

/** Origin URLs can embed credentials (https://user:token@host/…) — never log them raw. */
export function maskUrl(u: string | null): string | null {
  if (u === null) return null;
  if (/^https?:\/\//i.test(u)) {
    try {
      const parsed = new URL(u);
      const authority = parsed.username || parsed.password
        ? `${parsed.protocol}//***@${parsed.host}`
        : `${parsed.protocol}//${parsed.host}`;
      return `${authority}${parsed.pathname}${parsed.search ? '?***' : ''}${parsed.hash ? '#***' : ''}`;
    } catch {
      // Fall through to the conservative userinfo replacement for malformed URLs.
    }
  }
  return u.replace(/\/\/[^@/]+@/, '//***@');
}

interface RemoteIdentity {
  owner: string;
  project?: string;
  repo: string;
}

function identityFromSegments(host: string, segments: string[]): RemoteIdentity | null {
  const decoded = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (host === 'ssh.dev.azure.com' && decoded[0]?.toLowerCase() === 'v3' && decoded.length >= 4) {
    return { owner: decoded[1]!, project: decoded[2], repo: decoded[3]! };
  }
  const gitIndex = decoded.findIndex((segment) => segment.toLowerCase() === '_git');
  if (gitIndex >= 0) {
    const repo = decoded[gitIndex + 1];
    if (!repo) return null;
    if (host === 'dev.azure.com') {
      return { owner: decoded[0] ?? '', project: gitIndex >= 2 ? decoded[gitIndex - 1] : undefined, repo };
    }
    if (host.endsWith('.visualstudio.com')) {
      const beforeGit = decoded.slice(0, gitIndex).filter((segment) => segment.toLowerCase() !== 'defaultcollection');
      return {
        owner: host.slice(0, -'.visualstudio.com'.length),
        project: beforeGit.at(-1),
        repo,
      };
    }
    return { owner: decoded[gitIndex - 2] ?? '', project: decoded[gitIndex - 1], repo };
  }
  if (decoded.length < 2) return null;
  return { owner: decoded.slice(0, -1).join('/'), repo: decoded.at(-1)! };
}

function remoteIdentity(originUrl: string): RemoteIdentity | null {
  const cleaned = originUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  try {
    const parsed = new URL(cleaned);
    return identityFromSegments(parsed.hostname.toLowerCase(), parsed.pathname.split('/').filter(Boolean));
  } catch {
    const scp = cleaned.match(/^[^@]+@([^:]+):(.+)$/);
    if (!scp) return null;
    return identityFromSegments(scp[1]!.toLowerCase(), scp[2]!.split('/').filter(Boolean));
  }
}

/**
 * Only read the checkout's manifests when the checkout IS the PR's repo:
 * origin must end in the repo name and contain every owner segment (GitLab
 * nested namespaces put '/' in owner; ADO origins carry org/project/_git).
 */
export function cwdMatchesPr(
  originUrl: string | null,
  owner: string,
  repo: string,
  project?: string,
  pr?: Pick<PrRef, 'provider' | 'url' | 'baseUrl' | 'owner' | 'organization' | 'project'>,
): boolean {
  if (!originUrl) return false;
  const identity = remoteIdentity(originUrl);
  if (!identity) return false;
  const sameOwner = identity.owner.toLowerCase() === owner.toLowerCase();
  const sameRepo = identity.repo.toLowerCase() === repo.toLowerCase();
  const sameProject = project !== undefined
    ? identity.project !== undefined && identity.project.toLowerCase() === project.toLowerCase()
    : identity.project === undefined;
  const sameAuthority = pr
    ? canonicalRemoteAuthority(originUrl, pr.provider) === canonicalPrAuthority(pr)
    : true;
  return sameOwner && sameRepo && sameProject && sameAuthority;
}

export function defaultGitRemote(cwd: string): string | null {
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
    pr?: Pick<PrRef, 'owner' | 'repo'> & Partial<Pick<PrRef, 'provider' | 'url' | 'baseUrl' | 'organization' | 'project'>>;
    gitRemote?: (cwd: string) => string | null;
    gitToplevel?: (cwd: string) => string | null;
  },
): StackInfo {
  const notes: string[] = [];
  const dependencies = new Set<string>();
  const dependencyTokens = new Set<string>();
  const dependencyGroupMap = new Map<string, Set<string>>();
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
      for (const dep of parseJsonDependencyPatch(f.patch)) {
        dependencies.add(dep);
        const group = dependencyGroupMap.get(dep) ?? new Set<string>();
        for (const token of dependencyNameTokens(dep)) {
          dependencyTokens.add(token);
          group.add(token);
        }
        dependencyGroupMap.set(dep, group);
        if (dep.includes('/')) dependencies.add(dep.replace(/^@/, '').split('/')[0]!);
      }
    } else {
      for (const dep of parseManifest(base, added)) dependencies.add(dep);
      for (const token of parseManifestTokens(base, added)) dependencyTokens.add(token);
      for (const group of parseManifestDependencyGroups(base, added)) {
        const existing = dependencyGroupMap.get(group.dependency) ?? new Set<string>();
        for (const token of group.tokens) existing.add(token);
        dependencyGroupMap.set(group.dependency, existing);
      }
    }
  }

  let cwdIsPrRepo = false;
  if (opts.cwd && opts.pr) {
    const origin = (opts.gitRemote ?? defaultGitRemote)(opts.cwd);
    const authorityRef = opts.pr.provider && opts.pr.url
      ? opts.pr as Pick<PrRef, 'provider' | 'url' | 'baseUrl' | 'owner' | 'organization' | 'project'>
      : undefined;
    if (cwdMatchesPr(origin, opts.pr.owner, opts.pr.repo, opts.pr.project, authorityRef)) {
      cwdIsPrRepo = true;
      const root = (opts.gitToplevel ?? defaultGitToplevel)(opts.cwd) ?? opts.cwd;
      const dep = readDependencyTags(root, changedFiles.map((file) => file.path));
      for (const d of dep.dependencies) dependencies.add(d);
      for (const token of dep.tokens) dependencyTokens.add(token);
      for (const e of dep.ecosystems) ecosystems.add(e);
      for (const group of dep.groups) {
        const existing = dependencyGroupMap.get(group.dependency) ?? new Set<string>();
        for (const token of group.tokens) existing.add(token);
        dependencyGroupMap.set(group.dependency, existing);
      }
      notes.push(...dep.warnings.map((warning) => `manifest discovery degraded — ${warning}`));
    } else {
      notes.push(
        `cwd is not a checkout of ${opts.pr.owner}/${opts.pr.repo} (origin: ${maskUrl(origin) ?? 'none'}) — its manifests and skills are not used`,
      );
    }
  }

  const languages = new Set<string>();
  if (opts.linguist) {
    const preferredLanguages = new Set([...ecosystems, ...dependencies, ...dependencyTokens]);
    for (const f of changedFiles) {
      for (const language of languageTags(opts.linguist, f.path, preferredLanguages)) languages.add(language);
    }
  } else {
    notes.unshift('Linguist data unavailable — language tags skipped');
  }

  const deps = [...dependencies].sort();
  const depTokens = [...dependencyTokens].sort();
  const dependencyGroups = deps.map((dependency) => ({
    dependency,
    tokens: [...(dependencyGroupMap.get(dependency) ?? new Set(dependencyNameTokens(dependency)))].sort(),
  }));
  const ecosystemList = [...ecosystems].sort();
  const tags = [...new Set([...languages, ...deps, ...depTokens, ...ecosystemList])].sort();
  return {
    languages: [...languages].sort(),
    dependencies: deps,
    dependencyTokens: depTokens,
    dependencyGroups,
    ecosystems: ecosystemList,
    tags,
    notes,
    cwdIsPrRepo,
  };
}
