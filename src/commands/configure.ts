import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const GLOBAL_PATH = join(homedir(), '.pr-review', 'config.yaml');

interface RawConfig {
  default_model?: string;
  extra_reviewers_dirs?: string[];
  extra_skills_dirs?: string[];
  companion_warn?: boolean;
}

function readOrEmpty(): RawConfig {
  if (!existsSync(GLOBAL_PATH)) return {};
  try {
    return (parseYaml(readFileSync(GLOBAL_PATH, 'utf8')) as RawConfig) ?? {};
  } catch {
    return {};
  }
}

function writeConfig(cfg: RawConfig): void {
  mkdirSync(dirname(GLOBAL_PATH), { recursive: true });
  writeFileSync(GLOBAL_PATH, stringifyYaml(cfg), 'utf8');
}

export function runConfigureQuick(path: string, opts: { force?: boolean } = {}): void {
  const resolved = resolve(path.replace(/^~/, homedir()));
  const cfg = readOrEmpty();
  cfg.extra_reviewers_dirs = cfg.extra_reviewers_dirs ?? [];
  if (!cfg.extra_reviewers_dirs.includes(resolved)) {
    cfg.extra_reviewers_dirs.push(resolved);
  } else if (!opts.force) {
    process.stderr.write(`(${resolved} already in extra_reviewers_dirs; nothing changed)\n`);
    return;
  }
  writeConfig(cfg);
  process.stderr.write(`wrote ${GLOBAL_PATH}\n  extra_reviewers_dirs += ${resolved}\n`);
}

export async function runConfigureInteractive(): Promise<void> {
  const cfg = readOrEmpty();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = async (label: string, fallback: string): Promise<string> => {
    const answer = await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `);
    return answer.trim() || fallback;
  };
  try {
    cfg.default_model = await ask('Default model', cfg.default_model ?? 'claude-opus-4.8');
    const extraRev = await ask(
      'Extra reviewers dirs (comma-separated)',
      (cfg.extra_reviewers_dirs ?? []).join(','),
    );
    cfg.extra_reviewers_dirs = extraRev
      ? extraRev.split(',').map((s) => resolve(s.trim().replace(/^~/, homedir()))).filter(Boolean)
      : [];
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
