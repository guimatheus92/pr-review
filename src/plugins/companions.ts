import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReviewerDefinition } from '../types.js';

interface CompanionInfo {
  id: string;
  marketplace: string;
  installSlash: string;
  marketplaceSlash: string;
  description: string;
  entryCommand: string;
  invocable: boolean;
  invocableReason?: string;
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
  },
  {
    id: 'code-review',
    marketplace: 'claude-code-plugins',
    marketplaceSlash: '/plugin marketplace add anthropics/claude-code',
    installSlash: '/plugin install code-review@claude-code-plugins',
    description: 'Anthropic\'s code review with 0-100 confidence scoring; only ≥80 are surfaced.',
    entryCommand: '/code-review:code-review',
    invocable: true,
  },
];

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
  installed: string[];
  missing: CompanionInfo[];
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
  try {
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    if (!parsed || typeof parsed !== 'object' || !parsed.plugins) return [];
    return Object.keys(parsed.plugins).map((k) => k.split('@')[0]!);
  } catch {
    return [];
  }
}

function detectClaudePlugins(): string[] {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    return parseInstalledPluginsJson(raw);
  } catch (err) {
    process.stderr.write(
      `[companions] could not read ~/.claude/plugins/installed_plugins.json (${(err as Error).message.split('\n')[0]}); treating as none installed\n`,
    );
    return [];
  }
}

export async function detectCompanions(binary = 'copilot', runtime: 'copilot' | 'claude' = 'copilot'): Promise<CompanionState> {
  let installed: string[] = [];
  const debug = process.env.PR_REVIEW_DEBUG === '1';

  if (runtime === 'claude') {
    installed = detectClaudePlugins();
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
      process.stderr.write(
        `[companions] warning: \`${binary} plugin list\` failed (exit ${text.code}); treating as none installed.${text.stderr ? ' ' + text.stderr.trim().slice(0, 200) : ''}\n`,
      );
    } else {
      installed = parsePluginListOutput(text.stdout);
    }
  }
  const missing = KNOWN_COMPANIONS.filter((c) => !installed.includes(c.id));
  return { installed, missing };
}

export function formatWarning(missing: CompanionInfo[]): string {
  if (missing.length === 0) return '';
  const lines = [
    '⚠ Companion plugins not installed. Once installed, their agents run automatically alongside the built-ins.',
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
