/**
 * Minimal parser for `claude -p --output-format stream-json --verbose` output.
 * We only care about two things: (1) surfacing per-reviewer Task completions as
 * a live progress feed, and (2) reconstructing the final assistant text so the
 * existing stdout salvage/transient-detection paths still work. Everything else
 * in the event stream is ignored. Findings themselves come from the file the
 * orchestrator writes to disk — never from this stream — so a parsing miss here
 * can only dull the progress feed, never lose a review.
 */

export interface ReviewerTick {
  /** Short reviewer label, e.g. "security" (pr-review: prefix stripped). */
  name: string;
  elapsedMs: number;
}

export interface StreamState {
  /** tool_use_id → dispatched Task, awaiting its result. */
  pending: Map<string, { label: string; startedAt: number }>;
  /** Completed reviewer ticks, drained by the caller into the progress feed. */
  ticks: ReviewerTick[];
  /** Reconstructed final assistant text (the `result` event payload). */
  resultText: string;
}

export function newStreamState(): StreamState {
  return { pending: new Map(), ticks: [], resultText: '' };
}

function labelFrom(input: unknown): string {
  const i = input as { subagent_type?: unknown; agent_type?: unknown } | null;
  const raw = typeof i?.subagent_type === 'string' ? i.subagent_type
    : typeof i?.agent_type === 'string' ? i.agent_type
    : undefined;
  return raw ? raw.replace(/^pr-review:/, '') : 'reviewer';
}

/**
 * Feed one NDJSON line. Non-JSON lines and unrelated event types are ignored.
 * New reviewer completions land in `state.ticks` (append-only); the caller
 * drains them to the progress feed.
 */
export function consumeStreamLine(line: string, state: StreamState, now: number): void {
  const t = line.trim();
  if (!t) return;
  let obj: { type?: string; message?: { content?: unknown }; result?: unknown };
  try {
    obj = JSON.parse(t);
  } catch {
    return;
  }
  const content = Array.isArray(obj.message?.content) ? (obj.message!.content as Array<Record<string, unknown>>) : null;

  if (obj.type === 'assistant' && content) {
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string' && /^task$/i.test(block.name) && typeof block.id === 'string') {
        state.pending.set(block.id, { label: labelFrom(block.input), startedAt: now });
      }
    }
  } else if (obj.type === 'user' && content) {
    for (const block of content) {
      const id = block.tool_use_id;
      if (block.type === 'tool_result' && typeof id === 'string' && state.pending.has(id)) {
        const p = state.pending.get(id)!;
        state.ticks.push({ name: p.label, elapsedMs: Math.max(0, now - p.startedAt) });
        state.pending.delete(id);
      }
    }
  } else if (obj.type === 'result' && typeof obj.result === 'string') {
    state.resultText += obj.result;
  }
}
