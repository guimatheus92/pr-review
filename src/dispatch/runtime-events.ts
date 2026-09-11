import type { Finding, Severity } from '../types.js';
import { safeRuntimeDiagnostic } from '../util/text.js';
import { SAFE_ARG_RE } from '../util/spawn.js';

const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_EVENTS = 20_000;
const MAX_TASKS = 256;
const MAX_TASK_RESULT_BYTES = 1024 * 1024;
const MAX_RUNTIME_ERROR = 1_000;
const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT'];

export interface CopilotTaskResult {
  taskName: string;
  toolCallId: string;
  content: string;
}

export interface CopilotRuntimeEvents {
  valid: boolean;
  resolvedModel?: string;
  runtimeError?: string;
  taskResults: CopilotTaskResult[];
  ambiguousTaskNames: string[];
  diagnostics: string[];
}

interface RuntimeEvent {
  type?: unknown;
  agentId?: unknown;
  data?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactFindings(content: string): Finding[] | undefined {
  if (Buffer.byteLength(content, 'utf8') > MAX_TASK_RESULT_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const item of parsed) {
    const finding = record(item);
    if (!finding || !SEVERITIES.includes(finding.severity as Severity)) return undefined;
    if (typeof finding.title !== 'string' || typeof finding.body !== 'string') return undefined;
    if (finding.file !== undefined && typeof finding.file !== 'string') return undefined;
    if (finding.line !== undefined && (!Number.isInteger(finding.line) || (finding.line as number) < 1)) return undefined;
    if (finding.endLine !== undefined && (!Number.isInteger(finding.endLine) || (finding.endLine as number) < 1)) return undefined;
  }
  return parsed as Finding[];
}

function boundedRuntimeError(message: string): string | undefined {
  return safeRuntimeDiagnostic(message, MAX_RUNTIME_ERROR);
}

function concreteModel(value: string): boolean {
  return value.length <= 128 && value.toLowerCase() !== 'auto' && SAFE_ARG_RE.test(value);
}

export function parseCopilotRuntimeEvents(stdout: string): CopilotRuntimeEvents {
  const diagnostics: string[] = [];
  const starts = new Map<string, string>();
  const ambiguousCallIds = new Set<string>();
  const seenCompletions = new Set<string>();
  const taskNameCounts = new Map<string, number>();
  const completions = new Map<string, { success: boolean; content?: string }>();
  const resolvedModels = new Set<string>();
  let runtimeError: string | undefined;
  let valid = true;
  let taskDispatchStarted = false;

  if (Buffer.byteLength(stdout, 'utf8') > MAX_STREAM_BYTES) {
    return {
      valid: false,
      taskResults: [],
      ambiguousTaskNames: [],
      diagnostics: [`runtime event stream exceeds ${MAX_STREAM_BYTES} bytes`],
    };
  }

  const lines = stdout.split(/\r?\n/);
  let eventCount = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    eventCount++;
    if (eventCount > MAX_EVENTS) {
      diagnostics.push(`runtime event stream exceeds ${MAX_EVENTS} events`);
      valid = false;
      break;
    }

    let event: RuntimeEvent;
    try {
      event = JSON.parse(line) as RuntimeEvent;
    } catch {
      diagnostics.push(`line ${index + 1}: invalid JSON`);
      valid = false;
      continue;
    }
    if (!record(event) || event.agentId !== undefined) continue;
    const data = record(event.data);
    if (!data) continue;

    if (event.type === 'session.auto_mode_resolved') {
      if (!taskDispatchStarted && typeof data.chosenModel === 'string' && data.chosenModel.trim()) {
        const chosenModel = data.chosenModel.trim();
        if (!concreteModel(chosenModel)) {
          diagnostics.push('non-concrete or unsafe Auto resolved model event');
          valid = false;
        } else {
          resolvedModels.add(chosenModel);
        }
      }
      continue;
    }
    if (event.type === 'session.error') {
      if (typeof data.message === 'string') runtimeError = boundedRuntimeError(data.message) ?? runtimeError;
      continue;
    }
    if (event.type === 'tool.execution_start' && data.toolName === 'task') {
      taskDispatchStarted = true;
      const args = record(data.arguments);
      const toolCallId = data.toolCallId;
      const name = args?.name;
      if (typeof toolCallId !== 'string' || typeof name !== 'string' || !name.trim()) continue;
      if (!starts.has(toolCallId)) starts.set(toolCallId, name);
      else {
        diagnostics.push(`duplicate task start for ${toolCallId}`);
        ambiguousCallIds.add(toolCallId);
      }
      taskNameCounts.set(name, (taskNameCounts.get(name) ?? 0) + 1);
      if (starts.size > MAX_TASKS) {
        diagnostics.push(`runtime event stream exceeds ${MAX_TASKS} tasks`);
        valid = false;
      }
      continue;
    }
    if (event.type === 'tool.execution_complete') {
      const toolCallId = data.toolCallId;
      if (typeof toolCallId !== 'string') continue;
      if (seenCompletions.has(toolCallId)) {
        diagnostics.push(`duplicate task completion for ${toolCallId}`);
        ambiguousCallIds.add(toolCallId);
        continue;
      }
      seenCompletions.add(toolCallId);
      if (!starts.has(toolCallId)) {
        diagnostics.push(`orphan task completion for ${toolCallId}`);
        ambiguousCallIds.add(toolCallId);
        continue;
      }
      const result = record(data.result);
      completions.set(toolCallId, {
        success: data.success === true,
        content: typeof result?.content === 'string' ? result.content : undefined,
      });
    }
  }

  let resolvedModel: string | undefined;
  if (resolvedModels.size === 1) resolvedModel = [...resolvedModels][0];
  else if (resolvedModels.size > 1) {
    diagnostics.push('conflicting Auto resolved model events');
    valid = false;
  }

  const ambiguousTaskNames = [...taskNameCounts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([name]) => name)
    .sort();
  const ambiguous = new Set(ambiguousTaskNames);
  const taskResults: CopilotTaskResult[] = [];
  if (valid) {
    for (const [toolCallId, taskName] of starts) {
      if (ambiguous.has(taskName) || ambiguousCallIds.has(toolCallId)) continue;
      const completion = completions.get(toolCallId);
      if (!completion?.success || completion.content === undefined || !exactFindings(completion.content)) continue;
      taskResults.push({ taskName, toolCallId, content: completion.content });
    }
  }

  if (!runtimeError && diagnostics.length > 0) {
    runtimeError = boundedRuntimeError(`Copilot JSONL: ${diagnostics.join('; ')}`);
  }
  return { valid, resolvedModel, runtimeError, taskResults, ambiguousTaskNames, diagnostics };
}