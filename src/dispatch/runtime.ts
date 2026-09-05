import { execFileSync } from 'node:child_process';

/**
 * The agent CLIs that can host the orchestrator session. The array is the source
 * of truth and the union derives from it (same shape as `PROVIDERS`/`Provider` in
 * `src/types.ts`) — a hand-written `Runtime[]` can silently go stale when the union
 * grows, and this list is what the process-level MCP denial test walks.
 */
export const RUNTIMES = ['copilot', 'claude'] as const;
export type Runtime = (typeof RUNTIMES)[number];

/** What users may ask for: a concrete runtime, or 'auto' = probe PATH. Single source for config/CLI/review. */
export type RuntimeChoice = Runtime | 'auto';

export const RUNTIME_CHOICES: RuntimeChoice[] = [...RUNTIMES, 'auto'];

/**
 * Per runtime, the flag that switches ambient MCP off at the PROCESS level —
 * categorical under claude, built-ins only under copilot (see below). Denying the
 * `mcp__*` tools is not enough on its own: the servers still boot (a cmd.exe +
 * conhost + npx + node each on win32, every console window leaking) only to be
 * unreachable.
 *
 * The two are NOT symmetric. claude's `--strict-mcp-config` ignores every MCP config
 * source. copilot's `--disable-builtin-mcps` covers only the built-ins; its ambient
 * (user/repo/plugin-configured) servers are switched off one name at a time by the
 * `--disable-mcp-server` list built from `discoverMcpCapabilities`, which is NOT part
 * of this record — so that plumbing is load-bearing under copilot, not redundant.
 *
 * `satisfies Record<Runtime, ...>` so a runtime added later fails to compile rather
 * than merely failing the suite after the fact; `as const` because a mutable export
 * holding a process-isolation switch can be blanked by any importer, and the
 * RUNTIMES-driven test would read the mutated value and stay green. The argv side is
 * covered by that test in `tests/runtime.test.ts`.
 */
export const MCP_PROCESS_DENIAL = {
  claude: '--strict-mcp-config',
  copilot: '--disable-builtin-mcps',
} as const satisfies Record<Runtime, string>;

/**
 * How `binaryOnPath` shells out. Injectable for the same reason `resolveToken`
 * takes one in both providers: without a seam the `auto` probe can only be
 * tested by mutating the machine's PATH, so the documented order — copilot
 * first, claude second, throw last — had no coverage at all.
 */
export type ProbeExec = (file: string, args: string[]) => void;

const defaultProbe: ProbeExec = (file, args) => {
  execFileSync(file, args, { stdio: ['ignore', 'pipe', 'ignore'] });
};

/** Exported for `pr-review doctor`. */
export function binaryOnPath(name: string, exec: ProbeExec = defaultProbe): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    exec(probe, [name]);
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
export function resolveRuntime(
  preferred: Runtime | 'auto' | undefined,
  binaryOverride?: string,
  exec: ProbeExec = defaultProbe,
): Runtime {
  if (preferred && preferred !== 'auto') return preferred;
  if (binaryOverride) return 'copilot';
  if (binaryOnPath('copilot', exec)) return 'copilot';
  if (binaryOnPath('claude', exec)) return 'claude';
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
  // A switch, not `if (claude) … return <copilot argv>`: under a fall-through a runtime
  // added later inherits copilot's ENTIRE command line — its tool flags, its `-s`, and
  // copilot's denial flag instead of its own. The `never` assignment below turns that
  // into a compile error at the place that actually builds the argv.
  switch (runtime) {
    case 'claude':
      return [
        '-p',
        '--model', model,
        '--permission-mode', 'dontAsk',
        '--tools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
        '--allowedTools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
        '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch,mcp__*',
        MCP_PROCESS_DENIAL[runtime],
        '--setting-sources', 'user',
        '--add-dir', addDir,
        ...repoArg,
        // `disabledMcpServers` is deliberately unread here: `--strict-mcp-config` is
        // categorical, so the per-server list is redundant under claude — and the claude
        // CLI has no `--disable-mcp-server` flag, so "completing" this branch with one
        // would kill every review at spawn.
      ];
    case 'copilot':
      return [
        '--model', model,
        '--allow-all-tools',
        '--deny-tool=shell',
        MCP_PROCESS_DENIAL[runtime],
        '--no-custom-instructions',
        '--no-ask-user',
        '--add-dir', addDir,
        ...repoArg,
        // Not redundant with MCP_PROCESS_DENIAL.copilot — see its docblock.
        ...disabledMcpServers.flatMap((server) => ['--disable-mcp-server', server]),
        '-s',
      ];
  }
  const unreachable: never = runtime;
  throw new Error(`unsupported runtime: ${String(unreachable)}`);
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
