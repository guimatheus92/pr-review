import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { SkillDefinition } from '../types.js';
import { foldPath, realpathCanonical } from '../util/realpath.js';
import { gitProvenance, gitProvenanceError, newProvenanceCache, type ProvenanceCache } from '../util/git.js';
import { printable } from './builtin.js';

export { foldPath };

/** Folded path of `path` relative to `root`, or null when it leaves the root. */
export function normalizedRelative(root: string, path: string): string | null {
  const rel = relative(root, resolve(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return null;
  return foldPath(rel);
}

/** Every proper directory prefix of a folded relative path, from the first component down. */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

export function changedPathSet(changedPaths: string[]): Set<string> {
  return new Set(changedPaths.map(foldPath));
}

/**
 * The branch under review can author two things inside the checkout: files, and
 * LINKS — a committed link shows up in the diff as its own path. So a path is
 * branch-authored when it, or any directory on the way to it, is in the diff.
 * What sits outside the checkout is out of the branch's reach through git alone;
 * the one way a checkout still lands a file out there (Windows writing through
 * a junction) is what the commit-and-clean gate in partitionTrustedProjectSkills
 * covers.
 */
export function prAuthoredPath(changed: Set<string>, rel: string): boolean {
  return changed.has(rel) || ancestorsOf(rel).some((dir) => changed.has(dir));
}

/**
 * A `SKILL.md` owns its directory: its sibling files (`references/`, examples) are
 * skill-shaped input the branch controls, reachable wherever a runtime can read them,
 * even though only `SKILL.md` loads as a skill and no sibling is materialized.
 * Trusting the skill because `SKILL.md` itself is unchanged would let a PR ship
 * branch-authored instructions beside it. Flat `<dir>/<name>.md` rules share a
 * directory with unrelated rules, so for those the file stays the unit.
 */
export function skillDirPrefix(normalized: string | null): string | null {
  if (normalized === null || !/(^|\/)skill\.md$/i.test(normalized)) return null;
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? null : normalized.slice(0, slash + 1);
}

/**
 * Splits loaded rules into the ones this PR's review may read and the ones it
 * may not: anything the branch authored (a changed file, a changed sibling of
 * a SKILL.md, a link on the way), and anything outside the checkout that is
 * not provably committed in its home repository. Skipped entries carry their
 * reason in `skipReason`. `provenance` lets one review share the git lookups
 * across the repo, home, explicit, configured and plugin partitions.
 */
export function partitionTrustedProjectSkills(
  skills: SkillDefinition[],
  cwd: string,
  changedPaths: string[],
  provenance: ProvenanceCache = newProvenanceCache(),
): { trusted: SkillDefinition[]; skipped: SkillDefinition[] } {
  const root = resolve(cwd);
  let realRoot = root;
  try {
    realRoot = realpathCanonical(root);
  } catch {
    // A missing cwd makes every lexical in-repo comparison fail closed below.
  }
  const changed = changedPathSet(changedPaths);
  const noted = new Set<string>();
  const trusted: SkillDefinition[] = [];
  const skipped: SkillDefinition[] = [];
  const skip = (skill: SkillDefinition, reason: string): void => {
    process.stderr.write(`[skills] skipped ${printable(skill.name)}: ${reason}\n`);
    skipped.push({ ...skill, skipReason: reason });
  };
  for (const skill of skills) {
    if (skill.origin === 'forced') {
      trusted.push(skill);
      continue;
    }
    const lexicalSource = normalizedRelative(root, skill.source);
    let real: string;
    try {
      real = realpathCanonical(skill.source);
    } catch {
      // The loader read this file moments ago; an unresolvable path now is a trust failure, not absence.
      skip(skill, 'its real path could not be resolved');
      continue;
    }
    const realSource = normalizedRelative(realRoot, real);
    const changedSource =
      (lexicalSource !== null && changed.has(lexicalSource)) ||
      (realSource !== null && changed.has(realSource));
    const dirPrefixes = [skillDirPrefix(lexicalSource), skillDirPrefix(realSource)].filter(
      (prefix): prefix is string => prefix !== null,
    );
    const changedBeside =
      dirPrefixes.length > 0 &&
      [...changed].some((path) => dirPrefixes.some((prefix) => path.startsWith(prefix)));
    if (changedSource || changedBeside) {
      skip(skill, 'changed by this PR');
      continue;
    }
    if (lexicalSource !== null && ancestorsOf(lexicalSource).some((dir) => changed.has(dir))) {
      skip(skill, 'reached through a link this PR added or changed');
      continue;
    }
    if (realSource === null) {
      // Outside the checkout — through a link in it, a configured dir, or a home
      // dir. The branch cannot commit there, but on Windows a checkout writes
      // THROUGH an NTFS junction into a shared directory, so the file must be
      // committed and clean in its home repository. A directory under no
      // repository at all is the reviewer's local configuration (noted once per
      // directory when reached through a link, the case a reader may not expect).
      const ownedDir = /^skill\.md$/i.test(basename(real)) ? dirname(real) : undefined;
      const state = gitProvenance(real, provenance, ownedDir);
      if (state === 'untracked' || state === 'dirty') {
        skip(skill, `${state} in its home repository — commit it to use it`);
        continue;
      }
      if (state === 'error') {
        skip(skill, `could not be verified with git in its home repository (${printable(gitProvenanceError(real, provenance) ?? 'git failed or is missing')})`);
        continue;
      }
      if (state !== 'clean' && state !== 'no-repo') {
        skip(skill, `unexpected provenance state '${String(state)}'`); // a new state is untrusted until named here
        continue;
      }
      if (state === 'no-repo' && lexicalSource !== null && !noted.has(dirname(real))) {
        noted.add(dirname(real));
        process.stderr.write(`[skills] note: ${printable(dirname(real))} is not under version control — trusted as local configuration\n`);
      }
    }
    trusted.push(skill);
  }
  return { trusted, skipped };
}

/**
 * Only forced (--force-skill) and configured (--skills-dir / extra_skills_dirs /
 * PR_REVIEW_SKILLS_DIR) skills were named by the reviewer's own invocation or
 * config, so only they may cross a checkout boundary; a checkout's own rules
 * belong to that checkout.
 */
export function skillsAllowedForCheckout(skills: SkillDefinition[], cwdIsPrRepo: boolean): SkillDefinition[] {
  return cwdIsPrRepo ? skills : skills.filter((skill) => skill.origin === 'forced' || skill.origin === 'configured');
}
