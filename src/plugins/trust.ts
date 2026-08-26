import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { SkillDefinition } from '../types.js';

function normalizedRelative(root: string, path: string): string | null {
  const rel = relative(root, resolve(path));
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return null;
  const normalized = rel.replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
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
    const linkedOutsideRepo = lexicalSource !== null && realSource === null;
    if (changedSource || linkedOutsideRepo) skipped.push(skill);
    else trusted.push(skill);
  }
  return { trusted, skipped };
}

/** Only explicitly forced skills may cross a checkout boundary. */
export function skillsAllowedForCheckout(skills: SkillDefinition[], cwdIsPrRepo: boolean): SkillDefinition[] {
  return cwdIsPrRepo ? skills : skills.filter((skill) => skill.origin === 'forced');
}