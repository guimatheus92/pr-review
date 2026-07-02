import pLimit from 'p-limit';
import { dispatchReviewer } from './copilot.js';
import { readResponseCache, writeResponseCache } from '../cache/store.js';
import { readFileSync } from 'node:fs';
import type { ReviewerDefinition, ReviewerOutput } from '../types.js';
import type { MaterializedPrompt } from './materialize.js';

export interface ParallelDispatchOptions {
  materializations: { reviewer: ReviewerDefinition; materialized: MaterializedPrompt }[];
  copilotBinary?: string;
  concurrencyByModel?: Record<string, number>;
  defaultConcurrency?: number;
  useResponseCache?: boolean;
  onStart?: (name: string, model: string) => void;
  onFinish?: (output: ReviewerOutput) => void;
}

const DEFAULT_PER_MODEL: Record<string, number> = {
  'claude-opus-4.8': 8,
  'claude-opus-4.7': 8,
  'claude-opus-4.6': 8,
  'claude-sonnet-4.6': 10,
  'claude-sonnet-4.5': 10,
  'claude-haiku-4.5': 12,
  'gpt-5.5': 10,
  'gpt-5.4': 10,
  'gpt-5.4-mini': 12,
  'gpt-5-mini': 12,
};

function limiterFor(
  model: string,
  byModel: Map<string, ReturnType<typeof pLimit>>,
  defaultConcurrency: number,
  byModelConfig: Record<string, number>,
) {
  let limiter = byModel.get(model);
  if (!limiter) {
    const limit = byModelConfig[model] ?? DEFAULT_PER_MODEL[model] ?? defaultConcurrency;
    limiter = pLimit(Math.max(1, limit));
    byModel.set(model, limiter);
  }
  return limiter;
}

export async function dispatchInParallel(opts: ParallelDispatchOptions): Promise<ReviewerOutput[]> {
  const {
    materializations,
    copilotBinary = 'copilot',
    concurrencyByModel = {},
    defaultConcurrency = 4,
    useResponseCache = true,
    onStart,
    onFinish,
  } = opts;
  const limiters = new Map<string, ReturnType<typeof pLimit>>();

  const tasks = materializations.map(({ reviewer, materialized }) => {
    const limiter = limiterFor(reviewer.model, limiters, defaultConcurrency, concurrencyByModel);
    return limiter(async () => {
      const promptBody = readFileSync(materialized.promptPath, 'utf8');
      if (useResponseCache) {
        const cached = readResponseCache(reviewer.name, promptBody);
        if (cached) {
          const out: ReviewerOutput = {
            ...cached.data,
            durationMs: 0,
            error: undefined,
          };
          onStart?.(reviewer.name, reviewer.model);
          onFinish?.(out);
          return out;
        }
      }
      onStart?.(reviewer.name, reviewer.model);
      const out = await dispatchReviewer({ reviewer, materialized, copilotBinary });
      if (useResponseCache && out.exitCode === 0 && !out.error) {
        try {
          writeResponseCache(reviewer.name, promptBody, out);
        } catch {
          // best-effort cache write
        }
      }
      onFinish?.(out);
      return out;
    });
  });

  return Promise.all(tasks);
}
