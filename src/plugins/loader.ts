import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ReviewerDefinition, SkillDefinition } from '../types.js';
import type { Config } from '../config.js';
import { autodiscoveryPaths } from '../config.js';
import { loadReviewerFile, loadSkillFile, loadBuiltInReviewers } from './builtin.js';
import type { PluginManifest, PluginReviewerEntry, PluginSkillEntry } from './types.js';

export interface LoadedSet {
  reviewers: ReviewerDefinition[];
  skills: SkillDefinition[];
}

function walkMdFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  let stats;
  try {
    stats = statSync(root);
  } catch {
    return out;
  }
  if (stats.isFile() && root.toLowerCase().endsWith('.md')) {
    return [root];
  }
  if (!stats.isDirectory()) return out;
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const skillFile = join(full, 'SKILL.md');
      if (existsSync(skillFile)) {
        out.push(skillFile);
      } else {
        out.push(...walkMdFiles(full));
      }
    } else if (entry.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function loadFromPaths(paths: string[], kind: 'reviewer' | 'skill'): (ReviewerDefinition | SkillDefinition)[] {
  const files: string[] = [];
  for (const p of paths) files.push(...walkMdFiles(p));
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    const norm = resolve(f);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  return unique.map((f) => (kind === 'reviewer' ? loadReviewerFile(f) : loadSkillFile(f)));
}

function loadPluginManifest(pluginDir: string): PluginManifest | null {
  const yamlPath = join(pluginDir, 'plugin.yaml');
  const ymlPath = join(pluginDir, 'plugin.yml');
  let raw: string | null = null;
  let manifestPath = '';
  if (existsSync(yamlPath)) {
    raw = readFileSync(yamlPath, 'utf8');
    manifestPath = yamlPath;
  } else if (existsSync(ymlPath)) {
    raw = readFileSync(ymlPath, 'utf8');
    manifestPath = ymlPath;
  } else {
    return null;
  }
  try {
    const parsed = parseYaml(raw) as PluginManifest;
    if (!parsed.name) {
      process.stderr.write(`[plugins] warning: ${manifestPath} missing 'name' field\n`);
    }
    return parsed;
  } catch (err) {
    process.stderr.write(`[plugins] failed to parse ${manifestPath}: ${(err as Error).message}\n`);
    return null;
  }
}

function loadPluginEntries(pluginDir: string, manifest: PluginManifest): LoadedSet {
  const reviewers: ReviewerDefinition[] = [];
  const skills: SkillDefinition[] = [];
  const baseAppliesTo = manifest.appliesTo ?? [];

  for (const r of manifest.reviewers ?? []) {
    const promptPath = resolve(pluginDir, r.prompt);
    if (!existsSync(promptPath)) {
      process.stderr.write(`[plugins] ${manifest.name}: reviewer ${r.id} prompt not found: ${promptPath}\n`);
      continue;
    }
    const def = loadReviewerFile(promptPath);
    reviewers.push({
      ...def,
      name: r.id,
      appliesTo: r.appliesTo ?? def.appliesTo.length ? def.appliesTo : baseAppliesTo,
      model: r.model ?? def.model,
      outputFormat: r.outputFormat ?? def.outputFormat,
      skipWhenNoMatch: r.skipWhenNoMatch ?? def.skipWhenNoMatch,
    });
  }
  for (const s of manifest.skills ?? []) {
    const skillPath = resolve(pluginDir, s.path);
    if (!existsSync(skillPath)) {
      process.stderr.write(`[plugins] ${manifest.name}: skill ${s.id} not found: ${skillPath}\n`);
      continue;
    }
    const def = loadSkillFile(skillPath);
    skills.push({
      ...def,
      name: s.id,
      appliesTo: s.appliesTo ?? def.appliesTo,
      injectInto: s.injectInto ?? def.injectInto,
    });
  }
  return { reviewers, skills };
}

function loadPlugin(pluginDir: string): LoadedSet {
  const manifest = loadPluginManifest(pluginDir);
  if (manifest) return loadPluginEntries(pluginDir, manifest);
  // No manifest — treat as a generic directory of reviewer .md files
  const reviewers = loadFromPaths([pluginDir], 'reviewer') as ReviewerDefinition[];
  return { reviewers, skills: [] };
}

function resolveNamedPlugin(name: string, cwd: string): string | null {
  const candidates = [
    join(cwd, 'node_modules', name),
    join(cwd, name),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'plugin.yaml')) || existsSync(join(c, 'plugin.yml'))) return c;
  }
  return null;
}

export interface LoadAllOptions {
  cwd: string;
  config: Config;
  includeBuiltIn?: boolean;
  /** Single-session mode dispatches only Copilot CLI agents — skip loading user reviewer .md files entirely. */
  skillsOnly?: boolean;
  /** Override the home directory used for autodiscovery (tests). */
  home?: string;
}

function isPrReviewDir(p: string): boolean {
  return /[\/\\]\.pr-review[\/\\]skills$/.test(p);
}

/** A skill from a generic shared dir must declare review intent via targeting frontmatter. */
function hasReviewTargeting(s: SkillDefinition): boolean {
  return s.appliesTo.length > 0 || (s.injectInto !== undefined && s.injectInto.length > 0);
}

export function loadAll(opts: LoadAllOptions): LoadedSet & { catalog: SkillDefinition[] } {
  const { cwd, config, includeBuiltIn = true, skillsOnly = false } = opts;
  const reviewers: ReviewerDefinition[] = [];
  const skills: SkillDefinition[] = [];
  const catalog: SkillDefinition[] = [];

  if (includeBuiltIn && !skillsOnly) {
    reviewers.push(...loadBuiltInReviewers());
  }

  if (config.autodiscover) {
    const paths = opts.home ? autodiscoveryPaths(cwd, opts.home) : autodiscoveryPaths(cwd);
    if (!skillsOnly) {
      const r = loadFromPaths([...paths.repoReviewers, ...paths.personalReviewers], 'reviewer') as ReviewerDefinition[];
      reviewers.push(...r);
    }
    // .pr-review/skills is review-intent by location — everything loads (both buckets).
    const prDirs = [...paths.repoSkills, ...paths.personalSkills].filter(isPrReviewDir);
    skills.push(...(loadFromPaths(prDirs, 'skill') as SkillDefinition[]));

    // Generic agent-skill dirs (.claude, .copilot, .github, .agents) also hold
    // unrelated skills. Targeted ones (applies_to/inject_into) inject as rules.
    // Untargeted REPO skills are surfaced as an on-demand catalog — reviewers read
    // the relevant ones themselves — instead of being dropped blind. Untargeted
    // HOME skills are personal noise (video/design helpers) and stay skipped.
    const repoGeneric = loadFromPaths(
      paths.repoSkills.filter((p) => !isPrReviewDir(p)),
      'skill',
    ) as SkillDefinition[];
    skills.push(...repoGeneric.filter(hasReviewTargeting));
    const repoUntargeted = repoGeneric.filter((s) => !hasReviewTargeting(s));
    catalog.push(...repoUntargeted);
    if (repoUntargeted.length > 0) {
      process.stderr.write(
        `[skills] catalog: ${repoUntargeted.length} untargeted skill(s) from repo shared dirs (.claude/.copilot/.github/.agents) listed for on-demand reading — add applies_to/inject_into or move to .pr-review/skills/ to inject them fully\n`,
      );
    }

    const personalGeneric = loadFromPaths(
      paths.personalSkills.filter((p) => !isPrReviewDir(p)),
      'skill',
    ) as SkillDefinition[];
    skills.push(...personalGeneric.filter(hasReviewTargeting));
    const personalSkipped = personalGeneric.filter((s) => !hasReviewTargeting(s)).length;
    if (personalSkipped > 0) {
      process.stderr.write(
        `[skills] skipped ${personalSkipped} untargeted skill(s) from home shared dirs (~/.claude etc.) — add applies_to/inject_into frontmatter or move them to .pr-review/skills/ to include them in reviews\n`,
      );
    }
  }

  if (!skillsOnly) {
    const explicitReviewers = loadFromPaths(config.reviewers, 'reviewer') as ReviewerDefinition[];
    reviewers.push(...explicitReviewers);
    const explicitReviewersDirs = loadFromPaths(config.reviewersDirs, 'reviewer') as ReviewerDefinition[];
    reviewers.push(...explicitReviewersDirs);
  }

  const explicitSkills = loadFromPaths(config.skills, 'skill') as SkillDefinition[];
  skills.push(...explicitSkills);
  const explicitSkillsDirs = loadFromPaths(config.skillsDirs, 'skill') as SkillDefinition[];
  skills.push(...explicitSkillsDirs);

  for (const dir of config.pluginDirs) {
    const set = loadPlugin(dir);
    if (!skillsOnly) reviewers.push(...set.reviewers);
    skills.push(...set.skills);
  }
  for (const name of config.plugins) {
    const resolved = resolveNamedPlugin(name, cwd);
    if (!resolved) {
      process.stderr.write(`[plugins] could not resolve named plugin '${name}' in node_modules\n`);
      continue;
    }
    const set = loadPlugin(resolved);
    if (!skillsOnly) reviewers.push(...set.reviewers);
    skills.push(...set.skills);
  }

  const deduped = dedupeByName({ reviewers, skills });
  // An injected skill (from .pr-review or a targeted twin) wins over its catalog
  // entry — the skill is already fully present, so drop the duplicate listing.
  const injectedNames = new Set(deduped.skills.map((s) => s.name));
  const catalogMap = new Map<string, SkillDefinition>();
  for (const s of catalog) {
    if (injectedNames.has(s.name)) continue;
    catalogMap.set(s.name, s); // later wins, mirrors skill dedupe
  }
  return { ...deduped, catalog: Array.from(catalogMap.values()) };
}

function dedupeByName(set: LoadedSet): LoadedSet {
  const reviewerMap = new Map<string, ReviewerDefinition>();
  for (const r of set.reviewers) {
    const existing = reviewerMap.get(r.name);
    if (!existing) {
      reviewerMap.set(r.name, r);
    } else if (existing.isBuiltIn && !r.isBuiltIn) {
      // User reviewer overrides built-in of same name
      reviewerMap.set(r.name, r);
    } else if (!existing.isBuiltIn && !r.isBuiltIn) {
      // Two non-built-in with same name; later wins, with warning
      process.stderr.write(
        `[plugins] warning: reviewer name '${r.name}' collides (${existing.source} vs ${r.source}); using latter\n`,
      );
      reviewerMap.set(r.name, r);
    }
  }
  const skillMap = new Map<string, SkillDefinition>();
  for (const s of set.skills) {
    if (skillMap.has(s.name)) {
      process.stderr.write(
        `[plugins] warning: skill name '${s.name}' collides; using ${s.source}\n`,
      );
    }
    skillMap.set(s.name, s);
  }
  return { reviewers: Array.from(reviewerMap.values()), skills: Array.from(skillMap.values()) };
}

export type { PluginManifest, PluginReviewerEntry, PluginSkillEntry };
