import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReviewerDefinition } from '../types.js';

type CompanionDispatch =
  | { kind: 'agents'; agents: readonly string[] }
  | { kind: 'slash'; command: string };

export interface CompanionInfo {
  id: string;
  marketplace: string;
  installSlash: string;
  marketplaceSlash: string;
  description: string;
  entryCommand: string;
  invocable: boolean;
  invocableReason?: string;
  dispatch: CompanionDispatch;
}

export const KNOWN_COMPANIONS: CompanionInfo[] = [
  {
    id: 'pr-review-toolkit',
    marketplace: 'claude-code-plugins',
    marketplaceSlash: '/plugin marketplace add anthropics/claude-code',
    installSlash: '/plugin install pr-review-toolkit@claude-code-plugins',
    description: 'Comprehensive PR review using six specialized review subagents (comment-analyzer, pr-test-analyzer, silent-failure-hunter, type-design-analyzer, code-reviewer, code-simplifier).',
    entryCommand: '/pr-review-toolkit:review-pr',
    invocable: true,
    dispatch: {
      kind: 'agents',
      agents: [
        'pr-review-toolkit:code-reviewer',
        'pr-review-toolkit:code-simplifier',
        'pr-review-toolkit:comment-analyzer',
        'pr-review-toolkit:pr-test-analyzer',
        'pr-review-toolkit:silent-failure-hunter',
        'pr-review-toolkit:type-design-analyzer',
      ],
    },
  },
  {
    id: 'code-review',
    marketplace: 'claude-code-plugins',
    marketplaceSlash: '/plugin marketplace add anthropics/claude-code',
    installSlash: '/plugin install code-review@claude-code-plugins',
    description: 'Anthropic\'s code review with 0-100 confidence scoring; only ≥80 are surfaced.',
    entryCommand: '/code-review:code-review',
    invocable: true,
    dispatch: { kind: 'slash', command: '/code-review:code-review' },
  },
];

export function recognizedCompanions(installed: string[]): string[] {
  const installedSet = new Set(installed);
  return KNOWN_COMPANIONS.filter((companion) => installedSet.has(companion.id)).map((companion) => companion.id);
}

function dispatchCount(companion: CompanionInfo): number {
  if (companion.dispatch.kind === 'agents') return companion.dispatch.agents.length;
  return 1;
}

export function companionDispatchCount(installed: string[]): number {
  const installedSet = new Set(installed);
  return KNOWN_COMPANIONS.reduce(
    (count, companion) => count + (installedSet.has(companion.id) ? dispatchCount(companion) : 0),
    0,
  );
}

export function companionReviewerNames(installed: string[]): string[] {
  const installedSet = new Set(installed);
  return KNOWN_COMPANIONS.filter((companion) => installedSet.has(companion.id)).flatMap((companion) =>
    companion.dispatch.kind === 'agents'
      ? companion.dispatch.agents.map(
          (agent) => `companion:${companion.id}/${agent.replace(/^[^:]+:/, '')}`,
        )
      : [`companion:${companion.id}`],
  );
}

const COMPANION_TIMEOUT_MS = 20 * 60 * 1000;

export interface CompanionReviewerDiscovery {
  reviewers: ReviewerDefinition[];
  skippedPlugins: { id: string; reason: string }[];
}

export function discoverCompanionReviewers(opts: {
  installed: string[];
  defaultModel: string;
  prUrl: string;
}): CompanionReviewerDiscovery {
  const reviewers: ReviewerDefinition[] = [];
  const skippedPlugins: { id: string; reason: string }[] = [];

  for (const companion of KNOWN_COMPANIONS) {
    if (!opts.installed.includes(companion.id)) continue;
    if (!companion.invocable) {
      skippedPlugins.push({
        id: companion.id,
        reason: companion.invocableReason ?? 'marked non-invocable',
      });
      continue;
    }
    reviewers.push({
      name: `companion:${companion.id}`,
      description: companion.description,
      source: `${companion.entryCommand} (slash command)`,
      promptBody: `${companion.entryCommand} ${opts.prUrl}`,
      appliesTo: [],
      model: opts.defaultModel,
      outputFormat: 'markdown',
      skipWhenNoMatch: false,
      isBuiltIn: false,
      rawPrompt: true,
      timeoutMs: COMPANION_TIMEOUT_MS,
    });
  }
  return { reviewers, skippedPlugins };
}

export interface CompanionState {
  /** Every plugin reported by the runtime. */
  installed: string[];
  /** Installed plugins pr-review knows how to dispatch. */
  recognized: string[];
  missing: CompanionInfo[];
  detectionError?: string;
}

function runCopilot(args: string[], copilotBinary = 'copilot', timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      copilotBinary,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'number') {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: err.code as number });
        } else if (err) {
          resolve({ stdout: '', stderr: err.message, code: -1 });
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
        }
      },
    );
  });
}

/** Exported for tests — the `copilot plugin list` output format is not machine-readable and this regex is the only contract. */
export function parsePluginListOutput(stdout: string): string[] {
  const installed: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^[\s•\-*+]+([a-z][a-z0-9-]+)(?:@[a-z][a-z0-9-]+)?(?:\s|$|\()/i);
    if (m) installed.push(m[1]!);
  }
  return installed;
}

/**
 * Claude Code records installs in ~/.claude/plugins/installed_plugins.json,
 * keyed "name@marketplace". Total function: malformed content yields [] —
 * companion detection is best-effort and must never crash a review run.
 */
export function parseInstalledPluginsJson(raw: string): string[] {
  return parseInstalledPluginsState(raw).installed;
}

export function parseInstalledPluginsState(raw: string): { installed: string[]; detectionError?: string } {
  try {
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    if (!parsed || typeof parsed !== 'object' || !parsed.plugins || typeof parsed.plugins !== 'object') {
      return { installed: [], detectionError: 'installed_plugins.json has no plugins object' };
    }
    return { installed: Object.keys(parsed.plugins).map((k) => k.split('@')[0]!) };
  } catch (error) {
    return { installed: [], detectionError: `installed_plugins.json is invalid JSON: ${(error as Error).message}` };
  }
}

export function detectClaudePlugins(home = homedir()): { installed: string[]; detectionError?: string } {
  try {
    const raw = readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    return parseInstalledPluginsState(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { installed: [] };
    const detectionError = `could not read ~/.claude/plugins/installed_plugins.json (${(err as Error).message.split('\n')[0]})`;
    process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
    return { installed: [], detectionError };
  }
}

export async function detectCompanions(binary = 'copilot', runtime: 'copilot' | 'claude' = 'copilot'): Promise<CompanionState> {
  let installed: string[] = [];
  let detectionError: string | undefined;
  const debug = process.env.PR_REVIEW_DEBUG === '1';

  if (runtime === 'claude') {
    ({ installed, detectionError } = detectClaudePlugins());
  } else {
    // Skip the --json probe in normal runs; it's not supported in Copilot CLI 1.0.52
    // and just adds a spawn of overhead that has timed out on cold Windows starts.
    const text = await runCopilot(['plugin', 'list'], binary);
    if (debug) {
      process.stderr.write(
        `[companions:debug] code=${text.code} stdout=${JSON.stringify(text.stdout.slice(0, 500))}\n`,
      );
    }
    if (text.code !== 0) {
      detectionError = `\`${binary} plugin list\` failed (exit ${text.code})`;
      process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
    } else {
      installed = parsePluginListOutput(text.stdout);
      if (installed.length === 0 && !/Installed plugins:/i.test(text.stdout)) {
        detectionError = '`copilot plugin list` returned an unrecognized output format';
        process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
      }
    }
  }
  const recognized = recognizedCompanions(installed);
  const missing = detectionError ? [] : KNOWN_COMPANIONS.filter((c) => !installed.includes(c.id));
  return { installed, recognized, missing, detectionError };
}

export function formatWarning(missing: CompanionInfo[]): string {
  if (missing.length === 0) return '';
  const lines = [
    '⚠ Companion plugins not installed. Once installed, their agents run automatically alongside selected skill passes.',
    '  Inside a `copilot` session, run these slash commands:',
  ];
  const seenMarketplace = new Set<string>();
  for (const c of missing) {
    if (!seenMarketplace.has(c.marketplaceSlash)) {
      lines.push(`    ${c.marketplaceSlash}`);
      seenMarketplace.add(c.marketplaceSlash);
    }
    lines.push(`    ${c.installSlash}`);
  }
  lines.push(`  Opt out for one run with --no-companions, or set companion_warn: false in ~/.pr-review/config.yaml.`);
  return lines.join('\n');
}
