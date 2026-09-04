import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { SkillDefinition } from '../types.js';
import { foldPath, realpathCanonical } from '../util/realpath.js';
import { gitProvenance, newProvenanceCache } from '../util/git.js';
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
 * The branch under review can author two things: files inside the checkout, and the
 * LINKS inside the checkout — a committed symlink shows up in the diff as its own
 * path. So a path is branch-authored when it, or any directory on the way to it, is
 * in the diff. Content whose real path is outside the checkout cannot be.
 */
export function prAuthoredPath(changed: Set<string>, rel: string): boolean {
  return changed.has(rel) || ancestorsOf(rel).some((dir) => changed.has(dir));
}

/**
 * A `SKILL.md` owns its directory: every pass is handed a `Source:` line and told
 * that relative `references/` links resolve from there, so the skill's sibling
 * files are reachable review input even though only `SKILL.md` loads as a skill.
 * Trusting the skill because `SKILL.md` itself is unchanged would let a PR ship
 * branch-authored instructions beside it. Flat `<dir>/<name>.md` rules share a
 * directory with unrelated rules, so for those the file stays the unit.
 */
export function skillDirPrefix(normalized: string | null): string | null {
  if (normalized === null || !/(^|\/)skill\.md$/i.test(normalized)) return null;
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? null : normalized.slice(0, slash + 1);
}

/** Repo rules changed by the PR are untrusted input and cannot instruct that PR's review. */
export function partitionTrustedProjectSkills(
  skills: SkillDefinition[],
  cwd: string,
  changedPaths: string[],
): { trusted: SkillDefinition[]; skipped: SkillDefinition[] } {
  const root = resolve(cwd);
  let realRoot = root;
  try {
    realRoot = realpathCanonical(root);
  } catch {
    // A missing cwd makes every lexical in-repo comparison fail closed below.
  }
  const changed = changedPathSet(changedPaths);
  const provenance = newProvenanceCache();
  const noted = new Set<string>();
  const trusted: SkillDefinition[] = [];
  const skipped: SkillDefinition[] = [];
  const skip = (skill: SkillDefinition, reason: string): void => {
    process.stderr.write(`[skills] skipped ${printable(skill.name)}: ${reason}\n`);
    skipped.push(skill);
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
      // The loader already read the file; failure here is a trust failure, not absence.
      skip(skill, 'file vanished after loading');
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
    if (lexicalSource !== null && realSource === null) {
      // Reached THROUGH a link in the checkout, landing outside it: the branch cannot
      // author the content — but on Windows a checkout writes THROUGH an NTFS junction
      // into the shared directory, so the file must be committed and clean in its home
      // repository. A directory under no repository at all is the reviewer's local
      // configuration. Personal (~) and configured dirs are not reached through the
      // checkout, so this gate does not apply to them.
      const ownedDir = /^skill\.md$/i.test(basename(real)) ? dirname(real) : undefined;
      const state = gitProvenance(real, provenance, ownedDir);
      if (state === 'untracked' || state === 'dirty') {
        skip(skill, `${state} in its home repository — commit it to use it`);
        continue;
      }
      if (state === 'no-repo' && !noted.has(dirname(real))) {
        noted.add(dirname(real));
        process.stderr.write(`[skills] note: ${printable(dirname(real))} is not under version control — trusted as local configuration\n`);
      }
    }
    trusted.push(skill);
  }
  return { trusted, skipped };
}

/** Forced and configured skills are the reviewer's own choice and may cross a checkout boundary. */
export function skillsAllowedForCheckout(skills: SkillDefinition[], cwdIsPrRepo: boolean): SkillDefinition[] {
  return cwdIsPrRepo ? skills : skills.filter((skill) => skill.origin === 'forced' || skill.origin === 'configured');
}
