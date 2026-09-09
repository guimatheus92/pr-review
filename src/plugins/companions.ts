import { spawnCli } from '../util/spawn.js';
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
  /** Claude Code: slash commands, typed inside a session. */
  installSlash: string;
  marketplaceSlash: string;
  /** Copilot CLI: shell commands — it has no `/plugin`. See `formatWarning`. */
  marketplaceCommand: string;
  installCommand: string;
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
    marketplaceCommand: 'copilot plugin marketplace add anthropics/claude-code',
    installCommand: 'copilot plugin install pr-review-toolkit@claude-code-plugins',
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
    marketplaceCommand: 'copilot plugin marketplace add anthropics/claude-code',
    installCommand: 'copilot plugin install code-review@claude-code-plugins',
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

/**
 * Runs the Copilot CLI through `spawnCli`, the same helper the review dispatch
 * uses — not `execFile`.
 *
 * `execFile` does no PATHEXT resolution, and on Windows the Copilot CLI is an
 * npm shim named `copilot.cmd`. So `execFile('copilot', …)` answered
 * `spawn copilot ENOENT` in 0.0s on every Windows run, every companion
 * detection reported `unknown`, and the acceptance report carried
 * "`copilot plugin list` failed (exit -1)" while the very same command worked
 * from a shell. `spawnCli` exists for exactly this ("win32 still needs a shell
 * for the .cmd shims") and the dispatch path had it; this second spawn path was
 * simply missed.
 *
 * Detection failure stays `unknown` rather than "not installed" — that part was
 * always right, which is why this degraded quietly for so long.
 */
function runCopilot(args: string[], copilotBinary = 'copilot', timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(copilotBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      // assertSafeArg rejects a binary path with shell metacharacters.
      resolve({ stdout: '', stderr: (e as Error).message, code: -1 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; code: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ stdout, stderr, code: -1 });
    }, timeoutMs);
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', (e: Error) => finish({ stdout: '', stderr: e.message, code: -1 }));
    child.on('close', (code: number | null) => finish({ stdout, stderr, code: code ?? -1 }));
  });
}

/**
 * Output that states "zero plugins" rather than failing to be understood.
 *
 * A machine with nothing installed gets `No plugins installed.` — a clear,
 * parseable answer. Only the `Installed plugins:` header was recognised, so
 * that answer counted as an unrecognised format: every clean machine carried a
 * permanent degraded warning, `missing` was suppressed (so pr-review never
 * suggested the companions it knows about), and — the part that matters — a
 * REAL format change became indistinguishable from the ordinary empty case.
 * A warning that fires on the normal path is a warning nobody reads.
 *
 * Exported for tests: this and `parsePluginListOutput` are the entire contract
 * with an output format that is not machine-readable.
 */
export function declaresEmptyPluginList(stdout: string): boolean {
  return /Installed plugins:/i.test(stdout) || /\bno plugins?\b[^.\n]{0,20}\b(installed|found)\b/i.test(stdout);
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
      if (installed.length === 0 && !declaresEmptyPluginList(text.stdout)) {
        detectionError = '`copilot plugin list` returned an unrecognized output format';
        process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
      }
    }
  }
  const recognized = recognizedCompanions(installed);
  const missing = detectionError ? [] : KNOWN_COMPANIONS.filter((c) => !installed.includes(c.id));
  return { installed, recognized, missing, detectionError };
}

/**
 * The install hint is per RUNTIME, because the two CLIs do not share a command
 * surface. Claude Code takes slash commands inside a session; the Copilot CLI
 * has no `/plugin`, it has `copilot plugin …` in the shell. Printing the slash
 * form under copilot — which is what this did for every runtime, under the
 * heading "Inside a `copilot` session" — was advice that cannot be followed:
 * the plugins stay uninstalled, `recognized` stays empty, and the review
 * silently runs with 7 fewer reviewers.
 *
 * The marketplace and plugin ids are the same on both (`anthropics/claude-code`
 * → `claude-code-plugins`); only the verb changes. Verified end to end on
 * win32: `copilot plugin marketplace add anthropics/claude-code`, then
 * `copilot plugin install pr-review-toolkit@claude-code-plugins`, then
 * `pr-review doctor` reporting 6 + 1 dispatches under copilot.
 *
 * `anthropics/claude-plugins-official` carries the same two plugins and is what
 * Claude Code installs from here, but the Copilot CLI REFUSES it: it validates
 * `marketplace.json` against its own schema and rejects ~90 of that catalog's
 * 292 entries ("plugins.N.source: Invalid input"). So the hint names the small
 * marketplace, which both runtimes accept. Direct repo installs
 * (`owner/repo:path`) also work but Copilot prints a deprecation warning, so
 * they are deliberately not what we teach.
 */
export function formatWarning(missing: CompanionInfo[], runtime: 'copilot' | 'claude' = 'copilot'): string {
  if (missing.length === 0) return '';
  const lines = [
    '⚠ Companion plugins not installed. Once installed, their agents run automatically alongside selected skill passes.',
    runtime === 'claude'
      ? '  Inside a `claude` session, run these slash commands:'
      : '  Run these commands in your shell:',
  ];
  const seenMarketplace = new Set<string>();
  for (const c of missing) {
    const marketplace = runtime === 'claude' ? c.marketplaceSlash : c.marketplaceCommand;
    if (!seenMarketplace.has(marketplace)) {
      lines.push(`    ${marketplace}`);
      seenMarketplace.add(marketplace);
    }
    lines.push(`    ${runtime === 'claude' ? c.installSlash : c.installCommand}`);
  }
  lines.push(`  Opt out for one run with --no-companions, or set companion_warn: false in ~/.pr-review/config.yaml.`);
  return lines.join('\n');
}
