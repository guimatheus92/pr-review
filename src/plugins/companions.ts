import { spawnCli } from '../util/spawn.js';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { realpathCanonical } from '../util/realpath.js';
import type { RuntimePluginSelector } from './installed.js';
import { safeRuntimeDiagnostic } from '../util/text.js';

type CompanionCriteria =
  | { kind: 'agent-files'; agents: readonly string[] }
  | { kind: 'code-review-command' };

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
  criteria: CompanionCriteria;
}

export interface CompanionPluginSource {
  id: string;
  roots: string[];
}

export interface MaterializedCompanionBrief {
  reviewerName: string;
  companionId: string;
  body: string;
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
    criteria: {
      kind: 'agent-files',
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
    criteria: { kind: 'code-review-command' },
  },
];

export function recognizedCompanions(installed: string[]): string[] {
  const installedSet = new Set(installed);
  return KNOWN_COMPANIONS.filter((companion) => installedSet.has(companion.id)).map((companion) => companion.id);
}

function dispatchCount(companion: CompanionInfo): number {
  if (companion.criteria.kind === 'agent-files') return companion.criteria.agents.length;
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
    companion.criteria.kind === 'agent-files'
      ? companion.criteria.agents.map(
          (agent) => `companion:${companion.id}/${agent.replace(/^[^:]+:/, '')}`,
        )
      : [`companion:${companion.id}`],
  );
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const NATIVE_COMPANION_DIRECTIVE_RE = new RegExp([
  '^\\s*(?:model|tools|allowed-tools|disallowed-tools|permissionMode)\\s*:',
  '\\bgh\\s+(?:pr|issue|search)\\b',
  '\\bmcp__github',
  '\\bTask\\s+tool\\b',
  '\\b(?:launch|spawn|delegate to)\\b.{0,60}\\b(?:agent|subagent)\\b',
  '\\bpost\\b.{0,50}\\b(?:comment|review thread)\\b',
  '\\bgit\\s+(?:diff|show|status|log)\\b',
  '\\b(?:Bash|PowerShell|WebFetch|WebSearch)\\s*\\(',
  '\\b(?:use|run|invoke|execute|call)\\b.{0,50}\\b(?:Bash|PowerShell|shell|WebFetch|WebSearch)\\b',
  '(?:^|[\\s`])(?:curl|wget)\\b',
  '\\b(?:fetch|download|clone|checkout)\\b.{0,60}\\b(?:pull request|PR|repository|repo|diff|URL)\\b',
  '\\b(?:run|execute|invoke)\\b.{0,40}\\b(?:tests?|test suite|npm|pnpm|yarn|pytest|dotnet\\s+test|mvn|gradle)\\b',
].join('|'), 'ims');

export function companionRuntimeDirective(body: string): string | undefined {
  return body.match(NATIVE_COMPANION_DIRECTIVE_RE)?.[0];
}

function parsedCompanionBody(raw: string, path: string): string {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!/^---\s*\r?\n/.test(normalized)) return normalized.trim();
  const closing = /^---\s*$/m.exec(normalized.slice(normalized.indexOf('\n') + 1));
  if (!closing) {
    throw new Error(`companion definition has unterminated frontmatter: ${path}`);
  }
  const bodyStart = normalized.indexOf('\n') + 1 + closing.index + closing[0].length;
  return normalized.slice(bodyStart).replace(/^\r?\n/, '').trim();
}

function safeCompanionCriteria(body: string, source: string): string {
  const sanitized = body.replace(
    /^By default, review unstaged changes from `git diff`\. The user may specify different files or scope to review\.\s*$/gim,
    'Review only the materialized PR context and diff.',
  ).trim();
  const directive = companionRuntimeDirective(sanitized);
  if (directive) {
    throw new Error(`companion definition contains a runtime-native directive (${directive.trim()}): ${source}`);
  }
  return sanitized;
}

function readDefinition(root: string, relativePath: string): { path: string; body: string } | undefined {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  if (!pathInside(resolvedRoot, candidate) || !existsSync(candidate)) return undefined;
  const realRoot = realpathCanonical(resolvedRoot);
  const realCandidate = realpathCanonical(candidate);
  if (!pathInside(realRoot, realCandidate)) return undefined;
  const raw = readFileSync(realCandidate, 'utf8');
  return { path: realCandidate, body: parsedCompanionBody(raw, realCandidate) };
}

function agreedDefinition(
  source: CompanionPluginSource,
  relativePath: string,
): string {
  const definitions = source.roots.map((root) => {
    const definition = readDefinition(root, relativePath);
    if (!definition) {
      throw new Error(
        `companion plugin '${source.id}' active runtime root has no readable ${relativePath}: ${root}`,
      );
    }
    return definition;
  });
  const bodies = new Set(definitions.map((definition) => definition.body.replace(/\r\n/g, '\n')));
  if (bodies.size !== 1) {
    throw new Error(`companion plugin '${source.id}' has divergent active definitions for ${relativePath}`);
  }
  return [...bodies][0]!;
}

function codeReviewCriteria(body: string): string {
  const highSignalMarker = '**CRITICAL: We only want HIGH SIGNAL issues.**';
  const highSignalStart = body.indexOf(highSignalMarker);
  const highSignalEnd = body.indexOf('\n5. For each issue found', highSignalStart);
  const falsePositiveMarker = 'Use this list when evaluating issues in Steps 4 and 5 (these are false positives, do NOT flag):';
  const falsePositiveStart = body.indexOf(falsePositiveMarker);
  const falsePositiveEnd = body.indexOf('\nNotes:', falsePositiveStart);
  if (highSignalStart < 0 || highSignalEnd < 0 || falsePositiveStart < 0 || falsePositiveEnd < 0) {
    throw new Error('companion plugin \'code-review\' no longer contains the expected high-signal review criteria');
  }
  return [
    '# Companion review criteria: code-review',
    '',
    'Review only the materialized PR context and diff. Validate each candidate directly and report only issues that meet these source-plugin criteria.',
    '',
    body.slice(highSignalStart, highSignalEnd).trim(),
    '',
    body.slice(falsePositiveStart, falsePositiveEnd).trim(),
  ].join('\n');
}

/** Resolve every required companion definition without invoking runtime-native agents or commands. */
export function materializeCompanionBriefs(opts: {
  installed: string[];
  sources: CompanionPluginSource[];
}): MaterializedCompanionBrief[] {
  const sourcesById = new Map(opts.sources.map((source) => [source.id, source]));
  if (sourcesById.size !== opts.sources.length) throw new Error('duplicate companion source id');
  const briefs: MaterializedCompanionBrief[] = [];
  for (const companion of KNOWN_COMPANIONS) {
    if (!opts.installed.includes(companion.id)) continue;
    const source = sourcesById.get(companion.id);
    if (!source || source.roots.length === 0) {
      throw new Error(`companion plugin '${companion.id}' was detected but has no active runtime source root`);
    }
    if (companion.criteria.kind === 'agent-files') {
      for (const agent of companion.criteria.agents) {
        const shortAgent = agent.replace(/^[^:]+:/, '');
        const relativePath = join('agents', `${shortAgent}.md`);
        const body = safeCompanionCriteria(agreedDefinition(source, relativePath), relativePath);
        briefs.push({
          reviewerName: `companion:${companion.id}/${shortAgent}`,
          companionId: companion.id,
          body,
        });
      }
      continue;
    }
    const definition = agreedDefinition(source, join('commands', 'code-review.md'));
    briefs.push({
      reviewerName: `companion:${companion.id}`,
      companionId: companion.id,
      body: safeCompanionCriteria(codeReviewCriteria(definition), join('commands', 'code-review.md')),
    });
  }
  return briefs;
}

export interface CompanionState {
  /** Every plugin reported by the runtime. */
  installed: string[];
  /** Installed plugins pr-review knows how to dispatch. */
  recognized: string[];
  /** Claude's effective enabled plugin identities, used to select exact registry roots. */
  activeClaudePlugins?: RuntimePluginSelector[];
  missing: CompanionInfo[];
  detectionError?: string;
}

function safeDetectionError(value: string): string {
  return safeRuntimeDiagnostic(value) ?? 'companion detection failed';
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
function runPluginCli(args: string[], binary: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
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
    return { installed: [], detectionError: safeDetectionError(`installed_plugins.json is invalid JSON: ${(error as Error).message}`) };
  }
}

function pluginListEntries(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of ['plugins', 'installedPlugins', 'installed']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function enabledField(record: Record<string, unknown>): boolean | undefined {
  if (typeof record.enabled === 'boolean') return record.enabled;
  for (const value of [record.enabled, record.status, record.state]) {
    if (typeof value !== 'string') continue;
    if (/^(?:enabled|active|loaded)$/i.test(value.trim())) return true;
    if (/^(?:disabled|inactive|not[- ]loaded)$/i.test(value.trim())) return false;
  }
  return undefined;
}

/** Parse Claude's cwd-aware, effective plugin inventory. Unknown shapes fail closed. */
export function parseClaudePluginListJson(raw: string): {
  installed: string[];
  activeClaudePlugins: RuntimePluginSelector[];
  detectionError?: string;
} {
  try {
    const entries = pluginListEntries(JSON.parse(raw) as unknown);
    if (!entries) {
      return { installed: [], activeClaudePlugins: [], detectionError: '`claude plugin list --json` has no plugin array' };
    }
    const installed = new Set<string>();
    const active = new Map<string, RuntimePluginSelector>();
    for (const value of entries) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { installed: [], activeClaudePlugins: [], detectionError: '`claude plugin list --json` contains a malformed plugin entry' };
      }
      const entry = value as Record<string, unknown>;
      const rawIdentity = stringField(entry, ['id', 'pluginId', 'plugin', 'name']);
      const marketplace = stringField(entry, ['marketplace', 'marketplaceName', 'source']);
      if (!rawIdentity) {
        return { installed: [], activeClaudePlugins: [], detectionError: '`claude plugin list --json` plugin entry has no identity' };
      }
      const key = rawIdentity.includes('@')
        ? rawIdentity
        : marketplace ? `${rawIdentity}@${marketplace}` : undefined;
      const id = rawIdentity.split('@')[0]!;
      installed.add(id);
      if (!KNOWN_COMPANIONS.some((companion) => companion.id === id)) continue;
      const enabled = enabledField(entry);
      if (enabled === undefined) {
        return { installed: [], activeClaudePlugins: [], detectionError: safeDetectionError(`Claude plugin '${id}' has no effective enable status`) };
      }
      if (!enabled) continue;
      const version = stringField(entry, ['version', 'installedVersion']);
      const root = stringField(entry, ['installPath', 'install_path', 'path']);
      if (!key || !version || !root) {
        return {
          installed: [],
          activeClaudePlugins: [],
          detectionError: safeDetectionError(`enabled Claude plugin '${id}' has no qualified identity, version, and install path`),
        };
      }
      const previous = active.get(key);
      if (previous && (previous.version !== version || resolve(previous.root) !== resolve(root))) {
        return { installed: [], activeClaudePlugins: [], detectionError: safeDetectionError(`Claude plugin '${key}' reports conflicting active installations`) };
      }
      active.set(key, { key, version, root: resolve(root) });
    }
    return { installed: [...installed], activeClaudePlugins: [...active.values()] };
  } catch (error) {
    return {
      installed: [],
      activeClaudePlugins: [],
      detectionError: safeDetectionError(`\`claude plugin list --json\` returned invalid JSON: ${(error as Error).message}`),
    };
  }
}

export function detectClaudePlugins(home = homedir()): { installed: string[]; detectionError?: string } {
  try {
    const raw = readFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    return parseInstalledPluginsState(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { installed: [] };
    const detectionError = safeDetectionError(`could not read ~/.claude/plugins/installed_plugins.json (${(err as Error).message})`);
    process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
    return { installed: [], detectionError };
  }
}

export async function detectCompanions(binary = 'copilot', runtime: 'copilot' | 'claude' = 'copilot'): Promise<CompanionState> {
  let installed: string[] = [];
  let activeInstalled: string[] = [];
  let activeClaudePlugins: RuntimePluginSelector[] | undefined;
  let detectionError: string | undefined;
  const debug = process.env.PR_REVIEW_DEBUG === '1';

  if (runtime === 'claude') {
    const result = await runPluginCli(['plugin', 'list', '--json'], binary);
    if (result.code !== 0) {
      detectionError = safeDetectionError(`\`${binary} plugin list --json\` failed (exit ${result.code})`);
      process.stderr.write(`[companions] warning: ${detectionError}; effective plugin state unknown\n`);
    } else {
      const parsed = parseClaudePluginListJson(result.stdout);
      installed = parsed.installed;
      activeClaudePlugins = parsed.activeClaudePlugins;
      activeInstalled = activeClaudePlugins.map((plugin) => plugin.key.split('@')[0]!);
      detectionError = parsed.detectionError;
      if (detectionError) {
        process.stderr.write(`[companions] warning: ${detectionError}; effective plugin state unknown\n`);
      }
    }
  } else {
    // Skip the --json probe in normal runs; it's not supported in Copilot CLI 1.0.52
    // and just adds a spawn of overhead that has timed out on cold Windows starts.
    const text = await runPluginCli(['plugin', 'list'], binary);
    if (debug) {
      process.stderr.write(
        `[companions:debug] code=${text.code} stdout=${JSON.stringify(text.stdout.slice(0, 500))}\n`,
      );
    }
    if (text.code !== 0) {
      detectionError = safeDetectionError(`\`${binary} plugin list\` failed (exit ${text.code})`);
      process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
    } else {
      installed = parsePluginListOutput(text.stdout);
      activeInstalled = installed;
      if (installed.length === 0 && !declaresEmptyPluginList(text.stdout)) {
        detectionError = '`copilot plugin list` returned an unrecognized output format';
        process.stderr.write(`[companions] warning: ${detectionError}; installation state unknown\n`);
      }
    }
  }
  const recognized = recognizedCompanions(activeInstalled);
  const missing = detectionError ? [] : KNOWN_COMPANIONS.filter((c) => !installed.includes(c.id));
  return { installed, recognized, activeClaudePlugins, missing, detectionError };
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
/**
 * The one place that maps a companion to the command that installs it in a
 * given runtime. `formatWarning` is not the only surface that hands a user an
 * install command — `doctor` renders one per missing companion — and when the
 * mapping lived inline at each site, fixing one left the other printing advice
 * that cannot be typed. Route every hint through this.
 */
export function installCommandFor(companion: CompanionInfo, runtime: 'copilot' | 'claude'): string {
  return runtime === 'claude' ? companion.installSlash : companion.installCommand;
}

/**
 * `runtime` is REQUIRED on purpose. As an optional parameter defaulting to one
 * runtime it compiled at every call site that forgot it and went on emitting
 * the other runtime's syntax — the silent half of the bug this fixes. Required,
 * a new consumer fails to build until it decides.
 */
export function formatWarning(missing: CompanionInfo[], runtime: 'copilot' | 'claude'): string {
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
    lines.push(`    ${installCommandFor(c, runtime)}`);
  }
  lines.push(`  Opt out for one run with --no-companions, or set companion_warn: false in ~/.pr-review/config.yaml.`);
  return lines.join('\n');
}
