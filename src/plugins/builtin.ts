import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ReviewerDefinition, SkillDefinition } from '../types.js';

function findPluginRoot(): string {
  const start = process.argv[1] ? dirname(process.argv[1]) : process.cwd();
  let cur = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(cur, 'plugin.json'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return start;
}

const PLUGIN_ROOT = findPluginRoot();
// Built-in reviewers now live as Copilot CLI agents in agents/<name>.md and are
// registered/dispatched by Copilot CLI itself via the `task` tool. The Node CLI
// no longer loads them as ReviewerDefinitions.
const BUILTIN_AGENT_NAMES = [
  'pr-review-security',
  'pr-review-quality',
  'pr-review-architecture',
  'pr-review-performance',
  'pr-review-test-coverage',
  'pr-review-silent-failure',
  'pr-review-verifier',
];

interface Frontmatter {
  description?: string;
  applies_to?: string[];
  appliesTo?: string[];
  model?: string;
  output_format?: 'json' | 'markdown';
  outputFormat?: 'json' | 'markdown';
  skip_when_no_match?: boolean;
  skipWhenNoMatch?: boolean;
  inject_into?: string[];
  injectInto?: string[];
  type?: 'reviewer' | 'skill';
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/;

export function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: raw };
  try {
    const meta = (parseYaml(m[1]!) as Frontmatter) ?? {};
    return { meta, body: m[2]! };
  } catch {
    return { meta: {}, body: raw };
  }
}

export function loadReviewerFile(filePath: string, isBuiltIn = false): ReviewerDefinition {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  const name = inferNameFromPath(filePath);
  return {
    name,
    description: meta.description,
    source: filePath,
    promptBody: body,
    appliesTo: meta.applies_to ?? meta.appliesTo ?? [],
    model: meta.model ?? 'claude-opus-4.8',
    outputFormat: meta.output_format ?? meta.outputFormat ?? 'json',
    skipWhenNoMatch: meta.skip_when_no_match ?? meta.skipWhenNoMatch ?? false,
    isBuiltIn,
  };
}

export function loadSkillFile(filePath: string): SkillDefinition {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return {
    name: inferNameFromPath(filePath),
    description: meta.description,
    source: filePath,
    body,
    appliesTo: meta.applies_to ?? meta.appliesTo ?? [],
    injectInto: meta.inject_into ?? meta.injectInto,
  };
}

function inferNameFromPath(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  if (norm.endsWith('/SKILL.md')) {
    const parts = norm.split('/');
    return parts[parts.length - 2]!;
  }
  return norm
    .split('/')
    .slice(-1)[0]!
    .replace(/\.md$/i, '')
    .toLowerCase();
}

function walkSkillDirs(root: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const skillFile = join(full, 'SKILL.md');
      try {
        if (statSync(skillFile).isFile()) {
          out.push(skillFile);
          continue;
        }
      } catch {
        // not a skill dir; recurse
      }
      out.push(...walkSkillDirs(full));
    } else if (entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

export function loadBuiltInReviewers(): ReviewerDefinition[] {
  // Built-in reviewers are Copilot CLI agents (agents/*.md) — registered with
  // Copilot CLI on plugin install, dispatched via task(agent_type=...) from
  // the orchestrator. They are not loaded as Node-side ReviewerDefinitions.
  return [];
}

export function getBuiltInAgentNames(): string[] {
  return [...BUILTIN_AGENT_NAMES];
}

export function loadFromDir(dirPath: string, type: 'reviewer' | 'skill'): (ReviewerDefinition | SkillDefinition)[] {
  const files = walkSkillDirs(dirPath);
  return files.map((f) => (type === 'reviewer' ? loadReviewerFile(f) : loadSkillFile(f)));
}
