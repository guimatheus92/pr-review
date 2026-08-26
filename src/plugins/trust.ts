import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SkillDefinition } from '../types.js';

function normalizedRelative(root: string, path: string): string | null {
  const rel = relative(root, resolve(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return null;
  const normalized = rel.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * A `SKILL.md` owns its directory: every pass is handed a `Source:` line and told
 * that relative `references/` links resolve from there, so the skill's sibling
 * files are reachable review input even though only `SKILL.md` loads as a skill.
 * Trusting the skill because `SKILL.md` itself is unchanged would let a PR ship
 * branch-authored instructions beside it. Flat `<dir>/<name>.md` rules share a
 * directory with unrelated rules, so for those the file stays the unit.
 */
function skillDirPrefix(normalized: string | null): string | null {
  if (normalized === null || !/(^|\/)skill\.md$/.test(normalized)) return null;
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
    realRoot = realpathSync(root);
  } catch {
    // A missing cwd makes every lexical in-repo comparison fail closed below.
  }
  const changed = new Set(
    changedPaths
      .map((path) => path.replace(/\\/g, '/'))
      .map((path) => (process.platform === 'win32' ? path.toLowerCase() : path)),
  );
  const trusted: SkillDefinition[] = [];
  const skipped: SkillDefinition[] = [];
  for (const skill of skills) {
    if (skill.origin === 'forced') {
      trusted.push(skill);
      continue;
    }
    const lexicalSource = normalizedRelative(root, skill.source);
    let realSource: string | null = null;
    try {
      realSource = normalizedRelative(realRoot, realpathSync(skill.source));
    } catch {
      // The loader already read the file; failure here is a trust failure, not absence.
    }
    const changedSource =
      (lexicalSource !== null && changed.has(lexicalSource)) ||
      (realSource !== null && changed.has(realSource));
    const dirPrefixes = [skillDirPrefix(lexicalSource), skillDirPrefix(realSource)].filter(
      (prefix): prefix is string => prefix !== null,
    );
    const changedBeside =
      dirPrefixes.length > 0 &&
      [...changed].some((path) => dirPrefixes.some((prefix) => path.startsWith(prefix)));
    const linkedOutsideRepo = lexicalSource !== null && realSource === null;
    if (changedSource || changedBeside || linkedOutsideRepo) skipped.push(skill);
    else trusted.push(skill);
  }
  return { trusted, skipped };
}

/** Only explicitly forced skills may cross a checkout boundary. */
export function skillsAllowedForCheckout(skills: SkillDefinition[], cwdIsPrRepo: boolean): SkillDefinition[] {
  return cwdIsPrRepo ? skills : skills.filter((skill) => skill.origin === 'forced');
}