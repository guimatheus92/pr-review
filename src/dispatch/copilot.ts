import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { ReviewerDefinition, ReviewerOutput } from '../types.js';
import type { MaterializedPrompt } from './materialize.js';
import { parseReviewerOutput } from './parsers.js';

interface DispatchOptions {
  reviewer: ReviewerDefinition;
  materialized: MaterializedPrompt;
  copilotBinary?: string;
  timeoutMs?: number;
  onProgress?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function dispatchReviewer(opts: DispatchOptions): Promise<ReviewerOutput> {
  const { reviewer, materialized, copilotBinary = 'copilot' } = opts;
  const timeoutMs = opts.timeoutMs ?? reviewer.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const promptBody = readFileSync(materialized.promptPath, 'utf8');

  return new Promise((resolve) => {
    const args = [
      '--model',
      reviewer.model,
      '--allow-all-tools',
      '--no-ask-user',
      '-s',
    ];

    const child = spawn(copilotBinary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.stdin.write(promptBody);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        reviewerName: reviewer.name,
        model: reviewer.model,
        findings: [],
        rawOutput: stderr,
        durationMs: Date.now() - start,
        exitCode: -1,
        error: err.message,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const findings = parseReviewerOutput(stdout, reviewer.outputFormat);
      resolve({
        reviewerName: reviewer.name,
        model: reviewer.model,
        findings,
        rawOutput: stdout,
        durationMs: Date.now() - start,
        exitCode: code ?? -1,
        error: timedOut ? `timed out after ${timeoutMs}ms` : undefined,
      });
    });
  });
}

export async function dispatchSequentially(
  materializations: { reviewer: ReviewerDefinition; materialized: MaterializedPrompt }[],
  copilotBinary = 'copilot',
  onProgress?: (name: string, idx: number, total: number) => void,
): Promise<ReviewerOutput[]> {
  const results: ReviewerOutput[] = [];
  for (let i = 0; i < materializations.length; i++) {
    const { reviewer, materialized } = materializations[i]!;
    onProgress?.(reviewer.name, i + 1, materializations.length);
    const out = await dispatchReviewer({ reviewer, materialized, copilotBinary });
    results.push(out);
  }
  return results;
}
