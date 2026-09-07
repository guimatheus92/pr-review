import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_MODEL } from '../dispatch/runtime.js';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const GLOBAL_PATH = join(homedir(), '.pr-review', 'config.yaml');

export interface GlobalRawConfig {
  default_model?: string;
  extra_reviewers_dirs?: string[];
  extra_skills_dirs?: string[];
  companion_warn?: boolean;
  skill_packs?: unknown[];
}

/** NOTE: yaml round-trip via parse/stringify drops comments (existing behaviour). */
export function readOrEmpty(path: string = GLOBAL_PATH): GlobalRawConfig {
  if (!existsSync(path)) return {};
  try {
    return (parseYaml(readFileSync(path, 'utf8')) as GlobalRawConfig) ?? {};
  } catch (err) {
    // An UNPARSEABLE config must not read as "empty" — a caller that writes the
    // result back would silently destroy the user's file.
    const first = (err as Error).message.split('\n')[0];
    throw new Error(`cannot parse ${path}: ${first} — fix it before changing config`);
  }
}

export function writeConfig(cfg: GlobalRawConfig, path: string = GLOBAL_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(cfg), 'utf8');
}

export function runConfigureQuick(path: string, opts: { force?: boolean } = {}): void {
  const resolved = resolve(path.replace(/^~/, homedir()));
  const cfg = readOrEmpty();
  // The review path loads skills only — reviewer dirs are never dispatched, so
  // the quick path writes extra_skills_dirs (selected like repo skill dirs; --force-skill <dir> is the per-run bypass).
  cfg.extra_skills_dirs = cfg.extra_skills_dirs ?? [];
  if (!cfg.extra_skills_dirs.includes(resolved)) {
    cfg.extra_skills_dirs.push(resolved);
  } else if (!opts.force) {
    process.stderr.write(`(${resolved} already in extra_skills_dirs; nothing changed)\n`);
    return;
  }
  writeConfig(cfg);
  process.stderr.write(`wrote ${GLOBAL_PATH}\n  extra_skills_dirs += ${resolved}\n`);
}

export async function runConfigureInteractive(): Promise<void> {
  const cfg = readOrEmpty();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (label: string, fallback: string): Promise<string> => {
    const answer = await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `);
    return answer.trim() || fallback;
  };
  try {
    cfg.default_model = await ask('Default model', cfg.default_model ?? DEFAULT_MODEL);
    // No reviewer dirs: standalone reviewers are never dispatched — skills are the only content.
    const extraSk = await ask(
      'Extra skills dirs (comma-separated)',
      (cfg.extra_skills_dirs ?? []).join(','),
    );
    cfg.extra_skills_dirs = extraSk
      ? extraSk.split(',').map((s) => resolve(s.trim().replace(/^~/, homedir()))).filter(Boolean)
      : [];
    const warn = await ask('Warn when companion plugins are missing? (y/n)', cfg.companion_warn === false ? 'n' : 'y');
    cfg.companion_warn = warn.toLowerCase().startsWith('y');
  } finally {
    rl.close();
  }
  writeConfig(cfg);
  process.stderr.write(`\nwrote ${GLOBAL_PATH}\n`);
}
