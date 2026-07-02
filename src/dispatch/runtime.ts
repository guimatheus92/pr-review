import { execFileSync } from 'node:child_process';

/** The agent CLI that hosts the orchestrator session. */
export type Runtime = 'copilot' | 'claude';

export const RUNTIMES: Runtime[] = ['copilot', 'claude'];

function binaryOnPath(name: string): boolean {
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
export function runtimeSpawnArgs(runtime: Runtime, model: string, addDir: string): string[] {
  if (runtime === 'claude') {
    return ['-p', '--model', model, '--dangerously-skip-permissions', '--add-dir', addDir];
  }
  return ['--model', model, '--allow-all-tools', '--no-ask-user', '--add-dir', addDir, '-s'];
}

/** How the runtime spells its subagent-dispatch tool. */
export function taskCall(runtime: Runtime, agentType: string, prompt: string): string {
  if (runtime === 'claude') {
    return `Task(subagent_type="${agentType}", prompt="${prompt}")`;
  }
  return `task(agent_type="${agentType}", prompt="${prompt}")`;
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
