import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillPack } from '../config.js';
import type { SkillDefinition } from '../types.js';
import { loadSkillFile, normalizeSkillName } from '../plugins/builtin.js';
import { matchesAny } from '../util/globs.js';
import { packDir } from './sync.js';

/** The skill name a pack-relative path will load under (mirrors loadSkillFile naming). */
function skillNameOf(rel: string): string {
  const parts = rel.split('/');
  const base = rel.endsWith('/SKILL.md') ? parts[parts.length - 2]! : parts[parts.length - 1]!.replace(/\.md$/i, '');
  return normalizeSkillName(base);
}

/**
 * Which files of a pack checkout load as skills. Include/exclude are globs
 * against the pack-relative path; exclude also matches the normalized skill
 * name (so `hunting-*` excludes `skills/hunting-x/SKILL.md`). Deliberately
 * NOT the loader's walkMdFiles — a whole checkout is full of READMEs and
 * docs that must not become review passes.
 */
export function listPackFiles(dir: string, include: string[], exclude: string[]): string[] {
  let entries: string[];
  try {
    entries = (readdirSync(dir, { recursive: true }) as string[]).map((e) => String(e).replace(/\\/g, '/'));
  } catch {
    return [];
  }
  return entries
    .filter((rel) => rel.toLowerCase().endsWith('.md'))
    .filter((rel) => !rel.startsWith('.git/') && !rel.includes('/node_modules/') && !rel.startsWith('node_modules/'))
    .filter((rel) => matchesAny(rel, include))
    .filter((rel) => !(exclude.length > 0 && (matchesAny(rel, exclude) || matchesAny(skillNameOf(rel), exclude))))
    .sort();
}

/**
 * Load every configured pack's skills from disk. A missing checkout simply
 * contributes nothing (ensurePacks already warned). Names are prefixed
 * `<pack>/<skill>` so packs can never collide with repo skills or each other.
 */
export function loadPackSkills(packs: SkillPack[], home?: string): SkillDefinition[] {
  const out: SkillDefinition[] = [];
  for (const pack of packs) {
    const dir = packDir(pack, home);
    if (!existsSync(dir)) continue;
    const byName = new Map<string, SkillDefinition>();
    for (const rel of listPackFiles(dir, pack.include, pack.exclude)) {
      const def = loadSkillFile(join(dir, rel));
      const name = `${pack.name}/${def.name}`;
      if (byName.has(name)) {
        process.stderr.write(`[packs] warning: duplicate skill name '${name}' in pack — later file wins (${rel})\n`);
      }
      byName.set(name, { ...def, name, pack: pack.name, origin: 'pack', mode: pack.mode });
    }
    out.push(...byName.values());
  }
  return out;
}
