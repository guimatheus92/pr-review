import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface Config {
  defaultModel: string;
  autodiscover: boolean;
  reviewers: string[];
  reviewersDirs: string[];
  skills: string[];
  skillsDirs: string[];
  plugins: string[];
  pluginDirs: string[];
  dedupeMode: 'strict' | 'loose' | 'off';
  diffExcludes: string[];
  skipReviewers: string[];
  companionWarn: boolean;
  invokeCompanions: boolean;
  language: string;
  /** Agent CLI hosting the session: copilot | claude | auto (probe PATH). */
  runtime: 'copilot' | 'claude' | 'auto';
  /** Run the Codex second-opinion reviewer when the codex CLI is installed. */
  invokeCodex: boolean;
}

const DEFAULTS: Config = {
  defaultModel: 'claude-opus-4.8',
  autodiscover: true,
  reviewers: [],
  reviewersDirs: [],
  skills: [],
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
  runtime?: 'copilot' | 'claude' | 'auto';
  invoke_codex?: boolean;
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
  if (raw.dedupe?.mode) target.dedupeMode = raw.dedupe.mode;
  if (raw.diff_excludes) target.diffExcludes.push(...raw.diff_excludes);
  if (raw.skip_reviewers) target.skipReviewers.push(...raw.skip_reviewers);
  if (typeof raw.companion_warn === 'boolean') target.companionWarn = raw.companion_warn;
  if (typeof raw.invoke_companions === 'boolean') target.invokeCompanions = raw.invoke_companions;
  if (raw.language) target.language = raw.language;
  if (raw.runtime) target.runtime = raw.runtime;
  if (typeof raw.invoke_codex === 'boolean') target.invokeCodex = raw.invoke_codex;
}

function applyEnv(target: Config): void {
  if (process.env.PR_REVIEW_DEFAULT_MODEL) target.defaultModel = process.env.PR_REVIEW_DEFAULT_MODEL;
  if (process.env.PR_REVIEW_REVIEWERS_DIR) target.reviewersDirs.push(expandHome(process.env.PR_REVIEW_REVIEWERS_DIR));
  if (process.env.PR_REVIEW_SKILLS_DIR) target.skillsDirs.push(expandHome(process.env.PR_REVIEW_SKILLS_DIR));
  if (process.env.PR_REVIEW_NO_COMPANION_WARN) target.companionWarn = false;
  if (process.env.PR_REVIEW_LANG) target.language = process.env.PR_REVIEW_LANG;
  const envRuntime = process.env.PR_REVIEW_RUNTIME;
  if (envRuntime === 'copilot' || envRuntime === 'claude' || envRuntime === 'auto') target.runtime = envRuntime;
  if (process.env.PR_REVIEW_NO_CODEX) target.invokeCodex = false;
}

export interface ConfigOverrides {
  reviewers?: string[];
  reviewersDirs?: string[];
  skills?: string[];
  skillsDirs?: string[];
  plugins?: string[];
  pluginDirs?: string[];
  skipReviewers?: string[];
  defaultModel?: string;
  autodiscover?: boolean;
  dedupeMode?: 'strict' | 'loose' | 'off';
  invokeCompanions?: boolean;
  language?: string;
  runtime?: 'copilot' | 'claude' | 'auto';
  invokeCodex?: boolean;
}

export interface LoadConfigOpts {
  cwd?: string;
  homeOverride?: string;
  cliOverrides?: ConfigOverrides;
}

export function loadConfig(opts: LoadConfigOpts = {}): { config: Config; sources: Record<string, string> } {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.homeOverride ?? homedir();
  const config: Config = JSON.parse(JSON.stringify(DEFAULTS));
  const sources: Record<string, string> = { defaults: 'built-in' };

  const globalPath = join(home, '.pr-review', 'config.yaml');
  if (existsSync(globalPath)) {
    applyRaw(config, readYamlFile(globalPath), home);
    sources.global = globalPath;
  }

  const repoPath = join(cwd, '.pr-review.yaml');
  if (existsSync(repoPath)) {
    applyRaw(config, readYamlFile(repoPath), cwd);
    sources.repo = repoPath;
  }

  // Env overrides files (defaults < global yaml < repo yaml < env < flags).
  applyEnv(config);
  sources.env = 'environment variables';

  const o = opts.cliOverrides ?? {};
  if (o.reviewers) config.reviewers.push(...o.reviewers.map((p) => resolve(cwd, expandHome(p))));
  if (o.reviewersDirs)
    config.reviewersDirs.push(...o.reviewersDirs.map((p) => resolve(cwd, expandHome(p))));
  if (o.skills) config.skills.push(...o.skills.map((p) => resolve(cwd, expandHome(p))));
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
      join(cwd, '.pr-review', 'skills'),
      join(cwd, '.claude', 'skills'),
      join(cwd, '.copilot', 'skills'),
      join(cwd, '.github', 'skills'),
      join(cwd, '.agents', 'skills'),
    ],
    personalReviewers: [] as string[],
    personalSkills: [
      join(home, '.pr-review', 'skills'),
      join(home, '.claude', 'skills'),
      join(home, '.copilot', 'skills'),
      join(home, '.agents', 'skills'),
    ],
  };
}
