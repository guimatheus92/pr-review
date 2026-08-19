import { exec } from 'node:child_process';
import { spawnCli } from '../util/spawn.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewerOutput } from '../types.js';
import { parseReviewerOutput } from './parsers.js';
import { OUTPUT_SHAPE, skillsRulesSentence } from './single-session.js';

const CODEX_TIMEOUT_MS = 15 * 60 * 1000;
export const CODEX_FAILURE_LOG = 'codex-failure.log';

export function detectCodex(binary = 'codex'): Promise<boolean> {
  return new Promise((res) => {
    // exec (not execFile): codex installs as a .cmd shim on win32, which only a
    // shell can launch, and shell+args-array trips DEP0190. Binary is our own
    // constant/config value, not untrusted input.
    exec(`${binary} --version`, { timeout: 10_000, windowsHide: true }, (err) => res(!err));
  });
}

export interface CodexReviewOptions {
  binary?: string;
  contextPath: string;
  skillsPath?: string;
  outDir: string;
  timeoutMs?: number;
}

/**
 * Pure post-spawn result mapping, exported for tests. Contract:
 * - exit 0 → findings as parsed, no error.
 * - nonzero exit (or timeout) with NO findings → errored run, empty findings.
 * - nonzero exit (or timeout) WITH findings → findings are kept (partial output
 *   is still useful) but `error` is set so the run is never reported as clean.
 */
export function mapCodexResult(args: {
  exitCode: number;
  timedOut: boolean;
  raw: string;
  durationMs: number;
}): ReviewerOutput {
  const findings = args.raw ? parseReviewerOutput(args.raw, 'json') : [];
  const base: ReviewerOutput = {
    reviewerName: 'codex',
    model: 'codex',
    findings,
    rawOutput: args.raw,
    durationMs: args.durationMs,
    exitCode: args.exitCode,
  };
  if (args.exitCode === 0 && !args.timedOut) return base;
  const cause = args.timedOut ? 'timed out' : `exited ${args.exitCode}`;
  return {
    ...base,
    error:
      findings.length > 0
        ? `codex exec ${cause} — kept ${findings.length} finding(s), output may be incomplete`
        : `codex exec ${cause}`,
  };
}

/**
 * Second-opinion reviewer running on the Codex CLI, in parallel with the main
 * orchestrator session. A different model family catches what the primary one
 * misses. Read-only sandbox; output captured via --output-last-message.
 */
export async function runCodexReviewer(opts: CodexReviewOptions): Promise<ReviewerOutput> {
  const start = Date.now();
  const outFile = resolve(opts.outDir, 'codex-output.txt');
  const prompt =
    `You are an adversarial second-opinion code reviewer. Read the PR review context at \`${opts.contextPath}\` (metadata, existing comments, diff).${skillsRulesSentence(opts.skillsPath)} ` +
    `Hunt for real bugs, security issues, and broken edge cases the diff introduces — assume other reviewers already caught the obvious; look for what they would miss. Do not restate existing comments. ` +
    `Output ONLY a JSON array of findings using the shape: ${OUTPUT_SHAPE}. If you find nothing, output []. No prose. No fences.`;

  const argv = [
    'exec',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '-C',
    opts.outDir,
    '-o',
    outFile,
    '-',
  ];

  const result = await new Promise<{ exitCode: number; timedOut: boolean; stderr: string; stdout: string }>((res) => {
    // stdout is captured, not ignored: a usage/flag error from `codex exec`
    // prints there and exits before any output file is written, which is the
    // one failure mode that leaves nothing at all to diagnose.
    const child = spawnCli(opts.binary ?? 'codex', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(prompt);
    child.stdin.end();
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
    }, opts.timeoutMs ?? CODEX_TIMEOUT_MS);
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      res({ exitCode: -1, timedOut, stderr: stderr + '\n' + err.message, stdout });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ exitCode: code ?? -1, timedOut, stderr, stdout });
    });
  });

  let raw = '';
  try {
    raw = readFileSync(outFile, 'utf8');
  } catch {
    // no output file — mapCodexResult treats empty raw as an errored run
  }
  const output = mapCodexResult({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    raw,
    durationMs: Date.now() - start,
  });
  if (output.error) {
    // Persist the whole thing, the way the orchestrator gets
    // orchestrator-failure.log. The 300-char stderr echo below scrolls past in
    // a detached run, and on an early exit `codex-output.txt` — the file the
    // debug skill points at — was never written at all.
    const logPath = resolve(opts.outDir, CODEX_FAILURE_LOG);
    try {
      writeFileSync(
        logPath,
        [
          `${output.error}`,
          `argv: ${JSON.stringify([opts.binary ?? 'codex', ...argv])}`,
          `exit: ${result.exitCode}  timedOut: ${result.timedOut}  durationMs: ${output.durationMs}`,
          ``,
          `--- stderr ---`,
          result.stderr,
          ``,
          `--- stdout ---`,
          result.stdout,
        ].join('\n'),
        'utf8',
      );
    } catch {
      // best-effort — never let a logging failure mask the reviewer's own
    }
    process.stderr.write(`[codex] ${output.error}: ${result.stderr.trim().slice(0, 300)}\n`);
    process.stderr.write(`[codex] full output → ${logPath}\n`);
  }
  return output;
}
