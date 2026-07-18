import { existsSync, readFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
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

/** Resolve to the real (symlink-followed) path so the same file reached via a
 *  symlinked dir dedupes to one entry. Falls back to lexical resolve on error. */
function realpathSafe(f: string): string {
  try {
    return realpathSync(f);
  } catch {
    return resolve(f);
  }
}

function loadFromPaths(paths: string[], kind: 'reviewer' | 'skill'): (ReviewerDefinition | SkillDefinition)[] {
  const files: string[] = [];
  for (const p of paths) files.push(...walkMdFiles(p));
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    const norm = realpathSafe(f);
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

/** A skill opts into explicit (authoritative) routing via targeting frontmatter. */
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
    // Skills live where the agent tools keep them (.claude, .copilot, .github,
    // .agents) — read them from there, never moved or duplicated. A skill that
    // declares targeting (applies_to/inject_into) injects as an explicit rule.
    // The rest of the REPO skills become the catalog: the review matches each
    // against the changed files and injects the relevant ones (see skill-match),
    // leaving the tail available on-demand. Untargeted HOME skills are personal
    // general-purpose helpers (video/design) — not review content — so skipped.
    const repoGeneric = loadFromPaths(paths.repoSkills, 'skill') as SkillDefinition[];
    skills.push(...repoGeneric.filter(hasReviewTargeting));
    const repoUntargeted = repoGeneric.filter((s) => !hasReviewTargeting(s));
    catalog.push(...repoUntargeted);
    if (repoUntargeted.length > 0) {
      process.stderr.write(
        `[skills] ${repoUntargeted.length} project skill(s) from repo dirs (.claude/.copilot/.github/.agents) — relevant ones injected per change, the rest available on-demand\n`,
      );
    }

    const personalGeneric = loadFromPaths(paths.personalSkills, 'skill') as SkillDefinition[];
    skills.push(...personalGeneric.filter(hasReviewTargeting));
    const personalSkipped = personalGeneric.filter((s) => !hasReviewTargeting(s)).length;
    if (personalSkipped > 0) {
      process.stderr.write(
        `[skills] skipped ${personalSkipped} personal skill(s) from home dirs (~/.claude etc.) — not used for review (add applies_to/inject_into to a repo skill to inject it)\n`,
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
  // A targeted/explicit skill wins over its catalog twin — it's already fully
  // present in the injected set, so drop the duplicate catalog listing.
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
