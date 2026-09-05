import { execFileSync } from 'node:child_process';

/** The agent CLI that hosts the orchestrator session. */
export type Runtime = 'copilot' | 'claude';

/** What users may ask for: a concrete runtime, or 'auto' = probe PATH. Single source for config/CLI/review. */
export type RuntimeChoice = Runtime | 'auto';

export const RUNTIMES: Runtime[] = ['copilot', 'claude'];

export const RUNTIME_CHOICES: RuntimeChoice[] = ['copilot', 'claude', 'auto'];

/**
 * The flag that stops a runtime from STARTING ambient MCP servers, per runtime.
 * Denying the `mcp__*` tools is not enough: the servers still boot (a cmd.exe +
 * conhost + npx + node each on win32, every console window leaking) only to be
 * unreachable. Typed `Record<Runtime, ...>` on purpose — a new runtime fails to
 * compile until it declares its switch, which a hand-written test cannot enforce.
 *
 * The two are not symmetric: claude's is categorical (every MCP config source is
 * ignored), copilot's covers built-ins and is completed per name by
 * `--disable-mcp-server`, so its reach is bounded by `discoverMcpCapabilities`.
 */
export const MCP_PROCESS_DENIAL: Record<Runtime, string> = {
  claude: '--strict-mcp-config',
  copilot: '--disable-builtin-mcps',
};

/** Exported for `pr-review doctor`. */
export function binaryOnPath(name: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [name], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which runtime to use. Explicit --runtime wins; otherwise a --copilot
 * binary override implies the copilot runtime (the flag predates dual-runtime
 * and always meant "copilot binary path"); otherwise probe PATH, copilot first.
 */
export function resolveRuntime(preferred: Runtime | 'auto' | undefined, binaryOverride?: string): Runtime {
  if (preferred && preferred !== 'auto') return preferred;
  if (binaryOverride) return 'copilot';
  if (binaryOnPath('copilot')) return 'copilot';
  if (binaryOnPath('claude')) return 'claude';
  throw new Error(
    'No agent runtime found: neither `copilot` nor `claude` is on PATH. Install one, or pass --runtime/--copilot with an explicit binary.',
  );
}

export function runtimeBinary(runtime: Runtime, binaryOverride?: string): string {
  return binaryOverride ?? runtime;
}

/** Non-interactive spawn argv for the orchestrator session (prompt goes on stdin). */
export function runtimeSpawnArgs(
  runtime: Runtime,
  model: string,
  addDir: string,
  repoRoot?: string,
  disabledMcpServers: readonly string[] = [],
): string[] {
  const repoArg = repoRoot && repoRoot !== addDir ? ['--add-dir', repoRoot] : [];
  if (runtime === 'claude') {
    return [
      '-p',
      '--model', model,
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
      '--allowedTools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
      '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch,mcp__*',
      MCP_PROCESS_DENIAL.claude,
      '--setting-sources', 'user',
      '--add-dir', addDir,
      ...repoArg,
    ];
  }
  return [
    '--model', model,
    '--allow-all-tools',
    '--deny-tool=shell',
    MCP_PROCESS_DENIAL.copilot,
    '--no-custom-instructions',
    '--no-ask-user',
    '--add-dir', addDir,
    ...repoArg,
    ...disabledMcpServers.flatMap((server) => ['--disable-mcp-server', server]),
    '-s',
  ];
}

/**
 * The generic subagent type both runtimes accept — every review pass, the
 * verifier, and the companion slash path dispatch as this type. There are no
 * registered reviewer agents any more.
 */
export const GENERIC_AGENT = 'general-purpose';

const TASK_DESCRIPTION_MAX = 80;

/** Keep task-tool chrome short, deterministic, and independent of branch-authored descriptions. */
export function sanitizeTaskDescription(description: string): string {
  const sanitized = description
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/[^A-Za-z0-9 _/.:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TASK_DESCRIPTION_MAX)
    .trimEnd();
  return sanitized || 'Run review task';
}

/** How the runtime spells its subagent-dispatch tool. */
export function taskCall(runtime: Runtime, agentType: string, prompt: string, description: string): string {
  const agent = JSON.stringify(agentType);
  const body = JSON.stringify(prompt);
  const label = JSON.stringify(sanitizeTaskDescription(description));
  if (runtime === 'claude') {
    return `Task(subagent_type=${agent}, prompt=${body}, description=${label})`;
  }
  return `task(agent_type=${agent}, prompt=${body}, description=${label})`;
}

export function taskToolName(runtime: Runtime): string {
  return runtime === 'claude' ? 'Task' : 'task';
}

// ponytail: the copilot-style default model id is not a valid claude CLI id;
// map only that one known default, pass anything user-specified through as-is.
export function normalizeModel(runtime: Runtime, model: string): string {
  if (runtime === 'claude' && model === 'claude-opus-4.8') return 'opus';
  return model;
}
