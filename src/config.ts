import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_MODEL, RUNTIME_CHOICES, type RuntimeChoice } from './dispatch/runtime.js';
import { PROVIDERS, type Provider } from './types.js';
import { safeSegment } from './util/tmp.js';

export interface Config {
  defaultModel: string;
  autodiscover: boolean;
  reviewers: string[];
  reviewersDirs: string[];
  skills: string[];
  forceSkills: string[];
  skillsDirs: string[];
  plugins: string[];
  pluginDirs: string[];
  dedupeMode: 'strict' | 'loose' | 'off';
  diffExcludes: string[];
  skipReviewers: string[];
  companionWarn: boolean;
  invokeCompanions: boolean;
  language: string;
  /** Agent CLI hosting the session, or 'auto' to probe PATH. */
  runtime: RuntimeChoice;
  /** Run the Codex second-opinion reviewer when the codex CLI is installed. */
  invokeCodex: boolean;
  /** Self-hosted hostname → provider mapping (e.g. github.mycorp.com: github). */
  hosts: Record<string, Provider>;
  /**
   * External skill packs (git repos) that supply the review passes. REPLACE
   * semantics — a yaml `skill_packs:` overrides the whole list (so `[]`
   * disables), unlike every other list key, which pushes across levels.
   */
  skillPacks: SkillPack[];
}

export interface SkillPack {
  /** Slug: pack dir name under ~/.pr-review/packs/ and the pass-name prefix. */
  name: string;
  /** 'owner/repo' shorthand (GitHub), a full git URL, or a local path (tests). */
  git: string;
  /** Branch/tag to pin; default = the repo's default branch. */
  ref?: string;
  /** Globs (pack-relative paths) selecting which files load as skills. */
  include: string[];
  /** Globs matched against the pack-relative path AND the normalized skill name. */
  exclude: string[];
  /** 'index' packs are never dispatched as passes — on-demand index only. */
  mode: 'auto' | 'index';
  /** Skill names inside THIS pack that run as a pass on every PR (generic lenses). */
  baseline: string[];
}

/**
 * The batteries-included pack list. Pointers, not content: sync refreshes the
 * content, and a renamed upstream file surfaces as a visible missing-baseline
 * warning. Override or disable entirely with `skill_packs:` in yaml.
 */
export const DEFAULT_PACKS: SkillPack[] = [
  {
    name: 'awesome-copilot',
    git: 'github/awesome-copilot',
    include: ['instructions/*.instructions.md', 'skills/*/SKILL.md'],
    exclude: [],
    mode: 'auto',
    baseline: [
      'code-review-generic',
      'security-and-owasp',
      'performance-optimization',
      'qa-engineering-best-practices',
      'self-explanatory-code-commenting',
    ],
  },
  {
    name: 'owasp',
    git: 'OWASP/CheatSheetSeries',
    include: ['cheatsheets/*.md'],
    exclude: [],
    mode: 'auto',
    baseline: ['error-handling', 'logging'],
  },
  {
    name: 'anthropic-cybersecurity',
    git: 'mukul975/Anthropic-Cybersecurity-Skills',
    include: ['skills/*/SKILL.md'],
    // ponytail: ONE curated list — operational/offensive verbs never useful in
    // a diff review (forensics, hunting, C2…). Data, not code; tune in yaml.
    exclude: [
      'hunting-*', 'exploiting-*', 'performing-*', 'conducting-*', 'executing-*',
      'triaging-*', 'reverse-*', 'deobfuscating-*', 'extracting-*', 'collecting-*',
      'acquiring-*', 'investigating-*', 'recovering-*',
      '*forensic*', '*malware*', '*incident-response*', '*siem*',
    ],
    mode: 'index',
    baseline: [],
  },
];

const DEFAULTS: Config = {
  defaultModel: DEFAULT_MODEL,
  autodiscover: true,
  reviewers: [],
  reviewersDirs: [],
  skills: [],
  forceSkills: [],
  skillsDirs: [],
  plugins: [],
  pluginDirs: [],
  dedupeMode: 'strict',
  diffExcludes: [],
  skipReviewers: [],
  companionWarn: true,
  invokeCompanions: true,
  language: 'en',
  runtime: 'auto',
  invokeCodex: true,
  hosts: {},
  skillPacks: DEFAULT_PACKS,
};

interface RawConfig {
  default_model?: string;
  autodiscover?: boolean;
  extra_reviewers?: string[];
  extra_reviewers_dirs?: string[];
  extra_skills?: string[];
  extra_skills_dirs?: string[];
  plugins?: (string | { name?: string; dir?: string })[];
  dedupe?: { mode?: 'strict' | 'loose' | 'off' };
  diff_excludes?: string[];
  skip_reviewers?: string[];
  companion_warn?: boolean;
  invoke_companions?: boolean;
  language?: string;
  runtime?: RuntimeChoice;
  invoke_codex?: boolean;
  hosts?: Record<string, string>;
  skill_packs?: (string | ({ git?: string } & Partial<SkillPack>))[];
}

/** Fill a raw `skill_packs` entry ('owner/repo' shorthand or object) with defaults. */
function normalizePack(raw: string | ({ git?: string } & Partial<SkillPack>)): SkillPack | null {
  const obj = typeof raw === 'string' ? { git: raw } : raw;
  if (!obj.git || typeof obj.git !== 'string') {
    process.stderr.write(`[config] warning: skill_packs entry without a git source ignored\n`);
    return null;
  }
  const inferredName = obj.name ?? obj.git.replace(/\/+$/, '').split('/').pop() ?? 'pack';
  const asList = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : null);
  if (obj.mode !== undefined && obj.mode !== 'auto' && obj.mode !== 'index') {
    process.stderr.write(`[config] warning: skill_packs['${inferredName}'].mode '${String(obj.mode)}' is not auto|index — using auto
`);
  }
  const include = asList(obj.include);
  const baseline = asList(obj.baseline) ?? [];
  if (obj.mode === 'index' && baseline.length > 0) {
    process.stderr.write(`[config] warning: skill_packs['${inferredName}'] is mode:index — its baseline pointers can never dispatch
`);
  }
  return {
    name: safeSegment(inferredName),
    git: obj.git,
    ref: obj.ref,
    include: include && include.length > 0 ? include : ['**/SKILL.md'],
    exclude: asList(obj.exclude) ?? [],
    mode: obj.mode === 'index' ? 'index' : 'auto',
    baseline,
  };
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return p;
}

function readYamlFile(path: string): RawConfig {
  if (!existsSync(path)) return {};
  try {
    return (parseYaml(readFileSync(path, 'utf8')) as RawConfig) ?? {};
  } catch (err) {
    process.stderr.write(`[config] warning: failed to parse ${path}: ${(err as Error).message}\n`);
    return {};
  }
}

function applyRaw(target: Config, raw: RawConfig, baseDir: string): void {
  if (raw.default_model) target.defaultModel = raw.default_model;
  if (typeof raw.autodiscover === 'boolean') target.autodiscover = raw.autodiscover;
  if (raw.extra_reviewers) target.reviewers.push(...raw.extra_reviewers.map((p) => resolve(baseDir, expandHome(p))));
  if (raw.extra_reviewers_dirs)
    target.reviewersDirs.push(...raw.extra_reviewers_dirs.map((p) => resolve(baseDir, expandHome(p))));
  if (raw.extra_skills) target.skills.push(...raw.extra_skills.map((p) => resolve(baseDir, expandHome(p))));
  if (raw.extra_skills_dirs)
    target.skillsDirs.push(...raw.extra_skills_dirs.map((p) => resolve(baseDir, expandHome(p))));
  if (raw.plugins) {
    for (const p of raw.plugins) {
      if (typeof p === 'string') target.plugins.push(p);
      else if (p.dir) target.pluginDirs.push(resolve(baseDir, expandHome(p.dir)));
      else if (p.name) target.plugins.push(p.name);
    }
  }
  if (raw.skill_packs !== undefined) {
    // REPLACE, not push: `skill_packs: []` disables packs, and a repo list
    // overrides the global list entirely (documented in the example yaml).
    // Guard the shape: `skill_packs:` with every entry commented out parses to
    // null, and a scalar is a typo — neither may crash every CLI command.
    if (!Array.isArray(raw.skill_packs)) {
      process.stderr.write(
        `[config] warning: skill_packs must be a list (got ${raw.skill_packs === null ? 'an empty key' : typeof raw.skill_packs}) — ignoring it; use skill_packs: [] to disable packs\n`,
      );
    } else {
      const seen = new Set<string>();
      target.skillPacks = raw.skill_packs
        .map(normalizePack)
        .filter((p): p is SkillPack => p !== null)
        .filter((p) => {
          if (seen.has(p.name)) {
            // Two different repos inferring the same name would silently share
            // one checkout dir — first wins, loudly.
            process.stderr.write(
              `[config] warning: duplicate skill pack name '${p.name}' (${p.git.replace(/\/\/[^@/]+@/, '//***@')}) — first entry wins; set a distinct name: on one of them\n`,
            );
            return false;
          }
          seen.add(p.name);
          return true;
        });
    }
  }
  if (raw.dedupe?.mode) target.dedupeMode = raw.dedupe.mode;
  if (raw.diff_excludes) target.diffExcludes.push(...raw.diff_excludes);
  if (raw.skip_reviewers) target.skipReviewers.push(...raw.skip_reviewers);
  if (typeof raw.companion_warn === 'boolean') target.companionWarn = raw.companion_warn;
  if (typeof raw.invoke_companions === 'boolean') target.invokeCompanions = raw.invoke_companions;
  if (raw.language) target.language = raw.language;
  if (raw.runtime) target.runtime = raw.runtime;
  if (typeof raw.invoke_codex === 'boolean') target.invokeCodex = raw.invoke_codex;
  for (const [host, provider] of Object.entries(raw.hosts ?? {})) {
    if ((PROVIDERS as readonly string[]).includes(provider)) {
      target.hosts[host.toLowerCase()] = provider as Provider;
    } else {
      process.stderr.write(
        `[config] warning: hosts.${host}: unknown provider "${provider}" (expected ${PROVIDERS.join(' | ')}); ignored\n`,
      );
    }
  }
}

function applyEnv(target: Config): void {
  if (process.env.PR_REVIEW_DEFAULT_MODEL) target.defaultModel = process.env.PR_REVIEW_DEFAULT_MODEL;
  if (process.env.PR_REVIEW_REVIEWERS_DIR) target.reviewersDirs.push(expandHome(process.env.PR_REVIEW_REVIEWERS_DIR));
  if (process.env.PR_REVIEW_SKILLS_DIR) target.skillsDirs.push(expandHome(process.env.PR_REVIEW_SKILLS_DIR));
  if (process.env.PR_REVIEW_NO_COMPANION_WARN) target.companionWarn = false;
  if (process.env.PR_REVIEW_LANG) target.language = process.env.PR_REVIEW_LANG;
  const envRuntime = process.env.PR_REVIEW_RUNTIME;
  if ((RUNTIME_CHOICES as string[]).includes(envRuntime ?? '')) target.runtime = envRuntime as RuntimeChoice;
  if (process.env.PR_REVIEW_NO_CODEX) target.invokeCodex = false;
}

export interface ConfigOverrides {
  reviewers?: string[];
  reviewersDirs?: string[];
  skills?: string[];
  forceSkills?: string[];
  skillsDirs?: string[];
  plugins?: string[];
  pluginDirs?: string[];
  skipReviewers?: string[];
  defaultModel?: string;
  autodiscover?: boolean;
  dedupeMode?: 'strict' | 'loose' | 'off';
  invokeCompanions?: boolean;
  language?: string;
  runtime?: RuntimeChoice;
  invokeCodex?: boolean;
}

export interface LoadConfigOpts {
  cwd?: string;
  /** Git checkout root for repository config; CLI-relative paths still resolve from cwd. */
  repoRoot?: string;
  homeOverride?: string;
  cliOverrides?: ConfigOverrides;
  /** Ignore checkout-local configuration until the gather proves it is unchanged by the PR. */
  includeRepoConfig?: boolean;
}

const warnedRepoHosts = new Set<string>();
function warnRepoHostsOnce(repoPath: string): void {
  if (warnedRepoHosts.has(repoPath)) return;
  warnedRepoHosts.add(repoPath);
  process.stderr.write(
    `[config] hosts: in ${repoPath} ignored — a checkout-local host map is untrusted (it decides where a credential is sent); move it to ~/.pr-review/config.yaml\n`,
  );
}

export function loadConfig(opts: LoadConfigOpts = {}): { config: Config; sources: Record<string, string> } {
  const cwd = opts.cwd ?? process.cwd();
  const repoRoot = opts.repoRoot ?? cwd;
  const home = opts.homeOverride ?? homedir();
  const config: Config = JSON.parse(JSON.stringify(DEFAULTS));
  const sources: Record<string, string> = { defaults: 'built-in' };

  const globalPath = join(home, '.pr-review', 'config.yaml');
  if (existsSync(globalPath)) {
    applyRaw(config, readYamlFile(globalPath), home);
    sources.global = globalPath;
  }

  const repoPath = join(repoRoot, '.pr-review.yaml');
  if (existsSync(repoPath)) {
    const repoRaw = readYamlFile(repoPath);
    // hosts: decides where a credential is sent, so a checkout-local map is never
    // merged — not even for `config show` — and its presence is reported once.
    if (repoRaw.hosts !== undefined) {
      delete repoRaw.hosts;
      warnRepoHostsOnce(repoPath);
    }
    if (opts.includeRepoConfig !== false) {
      applyRaw(config, repoRaw, repoRoot);
      sources.repo = repoPath;
    }
  }

  // Env overrides files (defaults < global yaml < repo yaml < env < flags).
  applyEnv(config);
  sources.env = 'environment variables';

  const o = opts.cliOverrides ?? {};
  if (o.reviewers) config.reviewers.push(...o.reviewers.map((p) => resolve(cwd, expandHome(p))));
  if (o.reviewersDirs)
    config.reviewersDirs.push(...o.reviewersDirs.map((p) => resolve(cwd, expandHome(p))));
  if (o.skills) config.skills.push(...o.skills.map((p) => resolve(cwd, expandHome(p))));
  if (o.forceSkills) config.forceSkills.push(...o.forceSkills.map((p) => resolve(cwd, expandHome(p))));
  if (o.skillsDirs) config.skillsDirs.push(...o.skillsDirs.map((p) => resolve(cwd, expandHome(p))));
  if (o.plugins) config.plugins.push(...o.plugins);
  if (o.pluginDirs) config.pluginDirs.push(...o.pluginDirs.map((p) => resolve(cwd, expandHome(p))));
  if (o.skipReviewers) config.skipReviewers.push(...o.skipReviewers);
  if (o.defaultModel) config.defaultModel = o.defaultModel;
  if (typeof o.autodiscover === 'boolean') config.autodiscover = o.autodiscover;
  if (o.dedupeMode) config.dedupeMode = o.dedupeMode;
  if (typeof o.invokeCompanions === 'boolean') config.invokeCompanions = o.invokeCompanions;
  if (o.language) config.language = o.language;
  if (o.runtime) config.runtime = o.runtime;
  if (typeof o.invokeCodex === 'boolean') config.invokeCodex = o.invokeCodex;
  if (Object.keys(o).length > 0) sources.flags = 'CLI flags';

  return { config, sources };
}

export function autodiscoveryPaths(cwd: string = process.cwd(), home: string = homedir()) {
  return {
    // Reviewers ship as Copilot CLI agents in the plugin's agents/ folder.
    // Project-specific review rules go in standard skill paths, NOT a
    // separate .pr-review/reviewers/ folder (deliberately not auto-discovered).
    repoReviewers: [] as string[],
    repoSkills: [
      join(cwd, '.claude', 'skills'),
      join(cwd, '.claude', 'rules'),
      join(cwd, '.copilot', 'skills'),
      join(cwd, '.github', 'skills'),
      join(cwd, '.github', 'instructions'),
      join(cwd, '.agents', 'skills'),
    ],
    personalReviewers: [] as string[],
    personalSkills: [
      join(home, '.claude', 'skills'),
      join(home, '.copilot', 'skills'),
      join(home, '.agents', 'skills'),
    ],
  };
}
