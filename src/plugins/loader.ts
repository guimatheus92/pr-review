import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ReviewerDefinition, SkillDefinition } from '../types.js';
import type { Config } from '../config.js';
import { autodiscoveryPaths } from '../config.js';
import { loadReviewerFile, loadSkillFile, loadBuiltInReviewers } from './builtin.js';
import { printable } from '../util/text.js';
import { loadPackSkills } from '../packs/load.js';
import type { PluginManifest, PluginReviewerEntry, PluginSkillEntry } from './types.js';
import { changedPathSet, normalizedRelative, partitionTrustedProjectSkills, prAuthoredPath } from './trust.js';
import { gitTopLevel, newProvenanceCache } from '../util/git.js';
import { discoverInstalledPlugins, type InstalledPlugin } from './installed.js';
import { realpathCanonical } from '../util/realpath.js';

function withOrigin(skills: SkillDefinition[], origin: NonNullable<SkillDefinition['origin']>): SkillDefinition[] {
  return skills.map((s) => ({ ...s, origin }));
}

export interface LoadedSet {
  reviewers: ReviewerDefinition[];
  skills: SkillDefinition[];
}

interface WalkOptions {
  /** True when this lexical path (a link, or a root under a PR-authored link) was added or changed by the PR — it must not be followed, nor read. */
  refuseLink?: (absPath: string) => boolean;
  /** Paths refused above, reported as degraded coverage. */
  skippedLinks?: string[];
  /** Checkout root: a link anywhere between it and a discovery root spends the single hop. */
  top?: string;
  /** Coverage the walk lost (dangling links, unreadable dirs, refused hops, unreadable files) — for the Degraded block. */
  warnings?: string[];
}

/** Never review material: version control internals and installed packages. */
const WALK_SKIP = new Set(['.git', 'node_modules']);

function warn(opts: WalkOptions, message: string): void {
  process.stderr.write(`[skills] ${message}\n`);
  opts.warnings?.push(message);
}

function entriesOf(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** Is any directory strictly between `top` and `path` a link? Unreadable counts as yes (the hop is spent, never gained). */
function linkAbove(path: string, top: string): boolean {
  const stop = resolve(top);
  for (let dir = dirname(resolve(path)); dir !== stop && normalizedRelative(stop, dir) !== null; dir = dirname(dir)) {
    try {
      if (lstatSync(dir).isSymbolicLink()) return true;
    } catch {
      return true;
    }
    if (dirname(dir) === dir) return false;
  }
  return false;
}

/**
 * Directory links (symlinks, NTFS junctions) are followed ONE hop: a workspace
 * shares one rule set across sibling checkouts by linking a discovery dir at it.
 * A link the PR itself added or changed is refused BEFORE anything behind it is
 * read (its target is attacker-chosen); links met inside the linked directory are
 * not followed, so the trust boundary is the reviewer's own link, not every repo
 * a chain of links happens to reach. trust.ts decides what the content may do.
 */
function walkMdFiles(root: string, opts: WalkOptions = {}): string[] {
  if (opts.refuseLink?.(root)) {
    opts.skippedLinks?.push(root);
    return [];
  }
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    return []; // an absent discovery dir is the normal case
  }
  let followLinks = true;
  if (stats.isSymbolicLink()) {
    followLinks = false;
    try {
      stats = statSync(root);
    } catch {
      warn(opts, `warning: ${printable(root)} is a dangling link — nothing loaded from it`);
      return [];
    }
  } else if (opts.top && linkAbove(root, opts.top)) {
    followLinks = false;
  }
  // An explicit file path is honored by name — README.md included.
  if (stats.isFile()) return root.toLowerCase().endsWith('.md') ? [root] : [];
  if (!stats.isDirectory()) return [];
  // Under a `skills` root a subdirectory is a skill only through its SKILL.md
  // (the convention every agent tool shares) and loose .md files count only at
  // the root; any other root (rules/, instructions/, a configured dir of loose
  // files) nests freely. README.md is never a skill in any walked directory.
  return walkDir(root, opts, /^skills$/i.test(basename(root)), followLinks, 0);
}

function walkDir(dir: string, opts: WalkOptions, strict: boolean, followLinks: boolean, depth: number): string[] {
  const out: string[] = [];
  const entries = entriesOf(dir);
  if (entries === null) {
    warn(opts, `warning: ${printable(dir)} could not be read — nothing loaded from it`);
    return out;
  }
  // A link is followed only when the walk that met it still has its hop and the PR did not author it.
  const followable = (path: string, hop: boolean): boolean => {
    if (!hop) {
      warn(opts, `not following ${printable(path)}: a link inside a linked directory (one hop only)`);
      return false;
    }
    if (opts.refuseLink?.(path)) {
      opts.skippedLinks?.push(path);
      return false;
    }
    return true;
  };
  for (const entry of entries) {
    if (WALK_SKIP.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = lstatSync(full);
    } catch {
      continue;
    }
    let childFollow = followLinks;
    if (s.isSymbolicLink()) {
      if (!followable(full, followLinks)) continue;
      childFollow = false;
      try {
        s = statSync(full);
      } catch {
        warn(opts, `warning: ${printable(full)} is a dangling link — nothing loaded from it`);
        continue;
      }
    }
    if (s.isDirectory()) {
      const skillFile = join(full, 'SKILL.md');
      let sf;
      try {
        sf = lstatSync(skillFile);
      } catch {
        sf = null;
      }
      if (sf?.isSymbolicLink()) {
        // The skill file itself is a link: same rules as a linked directory.
        if (!followable(skillFile, childFollow)) continue;
        try {
          sf = statSync(skillFile);
        } catch {
          warn(opts, `warning: ${printable(skillFile)} is a dangling link — the skill is not loaded`);
          continue;
        }
      }
      if (sf?.isFile()) {
        out.push(skillFile);
        continue;
      }
      if (!strict) {
        out.push(...walkDir(full, opts, strict, childFollow, depth + 1));
        continue;
      }
      const children = entriesOf(full);
      if (children === null) {
        warn(opts, `warning: ${printable(full)} could not be read — nothing loaded from it`);
      } else if (children.some((child) => existsSync(join(full, child, 'SKILL.md')))) {
        out.push(...walkDir(full, opts, strict, childFollow, depth + 1)); // a group folder of skills
      } else if (children.some((child) => child.toLowerCase().endsWith('.md'))) {
        warn(
          opts,
          `warning: ${printable(full)} has no SKILL.md — its .md files are not loaded as skills (give it a SKILL.md, or keep loose rules under a top-level rules/ or instructions/ dir)`,
        );
      }
    } else if (s.isFile() && entry.toLowerCase().endsWith('.md') && entry.toLowerCase() !== 'readme.md') {
      if (strict && depth > 0) {
        if (!out.includes(`loose:${dir}`)) {
          out.push(`loose:${dir}`); // marker: warn once per group folder (stripped below)
          warn(opts, `warning: ${printable(dir)} is a group folder — its loose .md files are not loaded as skills (a skill is <dir>/SKILL.md)`);
        }
        continue;
      }
      out.push(full);
    }
  }
  return out.filter((path) => !path.startsWith('loose:'));
}

/** Resolve to the real (symlink-followed) path so the same file reached via a
 *  symlinked dir dedupes to one entry. Falls back to lexical resolve on error. */
function realpathSafe(f: string): string {
  try {
    return realpathCanonical(f);
  } catch {
    return resolve(f);
  }
}

function pathsInsideRoot(paths: string[], root: string): string[] {
  const resolvedRoot = realpathSafe(root);
  return paths.filter((path) => {
    const resolvedPath = realpathSafe(path);
    const rel = relative(resolvedRoot, resolvedPath);
    const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) {
      process.stderr.write(`[skills] warning: refusing non-forced skill path outside checkout: ${JSON.stringify(path)}\n`);
    }
    return inside;
  });
}

function loadFromPaths(
  paths: string[],
  kind: 'reviewer' | 'skill',
  walk: WalkOptions = {},
): (ReviewerDefinition | SkillDefinition)[] {
  const files: string[] = [];
  for (const p of paths) files.push(...walkMdFiles(p, walk));
  const seen = new Set<string>();
  const unique = files.filter((f) => {
    const norm = realpathSafe(f);
    if (seen.has(norm)) return false;
    seen.add(norm);
    return true;
  });
  const loaded: (ReviewerDefinition | SkillDefinition)[] = [];
  for (const f of unique) {
    try {
      loaded.push(kind === 'reviewer' ? loadReviewerFile(f) : loadSkillFile(f));
    } catch (err) {
      // A walk that crosses into other repositories meets files the reviewer may not be able to read.
      warn(walk, `warning: ${printable(f)} could not be read (${printable(String((err as Error).message ?? err).split('\n')[0] ?? '')}) — not loaded`);
    }
  }
  return loaded;
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
  /** Changed PR paths; branch-authored in-repo rules are removed before name dedupe. */
  changedPaths?: string[];
}

/** A skill opts into explicit (authoritative) routing via applies_to globs. */
function hasReviewTargeting(s: SkillDefinition): boolean {
  return s.appliesTo.length > 0;
}

export function loadAll(
  opts: LoadAllOptions,
): LoadedSet & {
  catalog: SkillDefinition[];
  packSkills: SkillDefinition[];
  installedPluginSkills: SkillDefinition[];
  installedPlugins: InstalledPlugin[];
  skippedProjectSkills: SkillDefinition[];
  /** Coverage lost while walking (dangling links, unreadable dirs, refused hops, missing configured dirs). */
  warnings: string[];
} {
  const { config, includeBuiltIn = true, skillsOnly = false } = opts;
  const cwd = gitTopLevel(opts.cwd) ?? opts.cwd;
  const reviewers: ReviewerDefinition[] = [];
  const skills: SkillDefinition[] = [];
  const catalog: SkillDefinition[] = [];
  const skippedProjectSkills: SkillDefinition[] = [];
  const provenance = newProvenanceCache();
  const trust = (loaded: SkillDefinition[]): SkillDefinition[] => {
    if (!opts.changedPaths) return loaded;
    const partition = partitionTrustedProjectSkills(loaded, cwd, opts.changedPaths, provenance);
    skippedProjectSkills.push(...partition.skipped);
    return partition.trusted;
  };
  // A link the PR added or changed is refused at the walk, before its target is
  // read. Without changedPaths (`plugins list`) every link is the reviewer's own.
  const changed = opts.changedPaths ? changedPathSet(opts.changedPaths) : null;
  const skippedLinks: string[] = [];
  const warnings: string[] = [];
  const walk: WalkOptions = {
    top: cwd,
    skippedLinks,
    warnings,
    refuseLink: changed
      ? (absPath) => {
          const rel = normalizedRelative(cwd, absPath);
          return rel !== null && prAuthoredPath(changed, rel);
        }
      : undefined,
  };

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
    const repoGeneric = trust(withOrigin(loadFromPaths(paths.repoSkills, 'skill', walk) as SkillDefinition[], 'repo'));
    skills.push(...repoGeneric.filter(hasReviewTargeting));
    const repoUntargeted = repoGeneric.filter((s) => !hasReviewTargeting(s));
    catalog.push(...repoUntargeted);
    if (repoUntargeted.length > 0) {
      process.stderr.write(
        `[skills] ${repoUntargeted.length} project skill(s) from repo dirs (.claude/.copilot/.github/.agents) — relevant ones injected per change, the rest available on-demand\n`,
      );
    }

    const personalGeneric = trust(withOrigin(loadFromPaths(paths.personalSkills, 'skill', walk) as SkillDefinition[], 'home'));
    skills.push(...personalGeneric.filter(hasReviewTargeting));
    const personalSkipped = personalGeneric.filter((s) => !hasReviewTargeting(s)).length;
    if (personalSkipped > 0) {
      process.stderr.write(
        `[skills] skipped ${personalSkipped} personal skill(s) from home dirs (~/.claude etc.) — not used for review (give one applies_to globs, or move it into a repo skill dir, to run it as a pass)\n`,
      );
    }
  }

  if (!skillsOnly) {
    const explicitReviewers = loadFromPaths(config.reviewers, 'reviewer') as ReviewerDefinition[];
    reviewers.push(...explicitReviewers);
    const explicitReviewersDirs = loadFromPaths(config.reviewersDirs, 'reviewer') as ReviewerDefinition[];
    reviewers.push(...explicitReviewersDirs);
  }

  const explicitSkills = trust(
    withOrigin(loadFromPaths(pathsInsideRoot(config.skills, cwd), 'skill', walk) as SkillDefinition[], 'explicit'),
  );
  skills.push(...explicitSkills);
  // --force-skill takes a file OR a directory: injected whole, no scope, no trust
  // check, per run only — the deliberate bypass.
  const forceSkills = withOrigin(loadFromPaths(config.forceSkills, 'skill', { top: cwd, warnings }) as SkillDefinition[], 'forced');
  skills.push(...forceSkills);
  // --skills-dir / extra_skills_dirs / PR_REVIEW_SKILLS_DIR: the same treatment as
  // a repo skill dir (targeted → scoped rule, untargeted → relevance heuristic,
  // unmatched → index), subject to rule trust, kept when cwd is not the PR repo.
  const configuredDirs = config.skillsDirs.filter((dir) => {
    if (existsSync(dir)) return true;
    warn(walk, `warning: configured skills dir ${printable(dir)} does not exist — nothing loaded from it`);
    return false;
  });
  const configuredLoaded = loadFromPaths(configuredDirs, 'skill', walk) as SkillDefinition[];
  const configured = trust(withOrigin(configuredLoaded, 'configured'));
  skills.push(...configured.filter(hasReviewTargeting));
  catalog.push(...configured.filter((s) => !hasReviewTargeting(s)));
  if (configuredLoaded.length > 0) {
    process.stderr.write(
      `[skills] ${configuredLoaded.length} skill(s) read from configured dirs (--skills-dir / extra_skills_dirs / PR_REVIEW_SKILLS_DIR), ${configured.length} trusted — selected like repo skills; --force-skill <dir> injects a directory whole\n`,
    );
  } else if (configuredDirs.length > 0) {
    warn(
      walk,
      `warning: no skills found in configured dir(s) ${configuredDirs.map((dir) => printable(dir)).join(', ')} — under a \`skills\` root only <dir>/SKILL.md and flat .md files count`,
    );
  }

  for (const path of new Set(skippedLinks)) {
    const rel = normalizedRelative(cwd, path) ?? path;
    const reason = 'added or changed by this PR — not read';
    process.stderr.write(`[skills] skipped ${printable(rel)}: ${reason}\n`);
    skippedProjectSkills.push({ name: rel, source: path, body: '', appliesTo: [], skipReason: reason });
  }

  for (const dir of config.pluginDirs) {
    const set = loadPlugin(dir);
    if (!skillsOnly) reviewers.push(...set.reviewers);
    skills.push(...trust(withOrigin(set.skills, 'plugin')));
  }
  for (const name of config.plugins) {
    const resolved = resolveNamedPlugin(name, cwd);
    if (!resolved) {
      process.stderr.write(`[plugins] could not resolve named plugin '${name}' in node_modules\n`);
      continue;
    }
    const set = loadPlugin(resolved);
    if (!skillsOnly) reviewers.push(...set.reviewers);
    skills.push(...trust(withOrigin(set.skills, 'plugin')));
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
  // Pack skills are namespaced `<pack>/<skill>`, so they can never collide with
  // repo skills or each other — loaded last, never deduped against the rest.
  const packSkills = loadPackSkills(config.skillPacks, opts.home);
  const installedPlugins = discoverInstalledPlugins(opts.home);
  const installedPluginSkills = installedPlugins.flatMap((plugin) => plugin.skills);
  return {
    ...deduped,
    catalog: Array.from(catalogMap.values()),
    packSkills,
    installedPluginSkills,
    installedPlugins,
    skippedProjectSkills,
    warnings,
  };
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
    const existing = skillMap.get(s.name);
    const isEquivalentMirror =
      existing !== undefined &&
      existing.body === s.body &&
      existing.description === s.description &&
      JSON.stringify(existing.appliesTo) === JSON.stringify(s.appliesTo) &&
      JSON.stringify(existing.tags ?? []) === JSON.stringify(s.tags ?? []);
    if (existing && !isEquivalentMirror) {
      process.stderr.write(
        `[plugins] warning: skill name '${s.name}' collides; using ${s.source}\n`,
      );
    }
    skillMap.set(s.name, s);
  }
  return { reviewers: Array.from(reviewerMap.values()), skills: Array.from(skillMap.values()) };
}

export type { PluginManifest, PluginReviewerEntry, PluginSkillEntry };
