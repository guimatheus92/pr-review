import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ReviewerDefinition, SkillDefinition } from '../types.js';

interface Frontmatter {
  name?: unknown;
  description?: string;
  applies_to?: string[] | string;
  appliesTo?: string[] | string;
  // awesome-copilot convention: CSV string of globs (comma-separated) or a list.
  applyTo?: string[] | string;
  tags?: string[] | string;
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

export function parseFrontmatter(raw: string, sourcePath?: string): { meta: Frontmatter; body: string } {
  raw = raw.replace(/^\uFEFF/, ''); // Windows editors/PowerShell write a UTF-8 BOM, which would defeat the ^--- match
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return { meta: {}, body: raw };
  try {
    const meta = (parseYaml(m[1]!) as Frontmatter) ?? {};
    return { meta, body: m[2]! };
  } catch (err) {
    if (sourcePath) {
      process.stderr.write(
        `[skills] warning: invalid frontmatter YAML in ${sourcePath} — frontmatter ignored (${(err as Error).message.split('\n')[0]})\n`,
      );
    }
    return { meta: {}, body: raw };
  }
}

/**
 * Normalize a glob-list frontmatter value: a YAML list, or a CSV string
 * (awesome-copilot writes applyTo as one comma-separated string of globs,
 * sometimes with spaces after the commas). Anything else → [].
 */
export function parseGlobList(v: unknown): string[] {
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(v)) {
    return v.map((s) => String(s).trim()).filter(Boolean);
  }
  return [];
}

/** First `# heading` of the body — the description fallback for files with no frontmatter (OWASP cheat sheets). */
function firstHeading(body: string): string | undefined {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : undefined;
}

/**
 * Skill names are compared against stack tags and used in pass names, so fold
 * filename conventions into the agentskills.io shape: lowercase, hyphens,
 * no pack-specific suffixes.
 */
// ponytail: the two suffixed packs we ship (awesome-copilot `.instructions`, OWASP `-cheat-sheet`)
// are the only strip rules; add a suffix here if a new pack needs one.
export function normalizeSkillName(base: string): string {
  return base
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/(\.instructions|-cheat-sheet)$/, '');
}

export function loadReviewerFile(filePath: string, isBuiltIn = false): ReviewerDefinition {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw, filePath);
  const name = inferNameFromPath(filePath);
  return {
    name,
    description: meta.description,
    source: filePath,
    promptBody: body,
    appliesTo: parseGlobList(meta.applies_to ?? meta.appliesTo),
    model: meta.model ?? 'claude-opus-4.8',
    outputFormat: meta.output_format ?? meta.outputFormat ?? 'json',
    skipWhenNoMatch: meta.skip_when_no_match ?? meta.skipWhenNoMatch ?? false,
    isBuiltIn,
  };
}

export function loadSkillFile(filePath: string): SkillDefinition {
  const raw = readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw, filePath);
  const declaredName = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : undefined;
  return {
    name: normalizeSkillName(declaredName ?? inferNameFromPath(filePath)),
    description: meta.description ?? firstHeading(body),
    source: filePath,
    body,
    appliesTo: parseGlobList(meta.applies_to ?? meta.appliesTo ?? meta.applyTo),
    injectInto: meta.inject_into ?? meta.injectInto,
    tags: parseGlobList(meta.tags),
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
  // There are no built-in reviewers: every review pass is a skill selected at
  // review time (packs + repo skills). Kept only until the loader drops it.
  return [];
}

export function loadFromDir(dirPath: string, type: 'reviewer' | 'skill'): (ReviewerDefinition | SkillDefinition)[] {
  const files = walkSkillDirs(dirPath);
  return files.map((f) => (type === 'reviewer' ? loadReviewerFile(f) : loadSkillFile(f)));
}
