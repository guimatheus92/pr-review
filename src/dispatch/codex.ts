import { exec } from 'node:child_process';
import { spawnCli } from '../util/spawn.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewerOutput } from '../types.js';
import { parseReviewerOutput } from './parsers.js';
import { OUTPUT_SHAPE, skillsRulesSentence } from './single-session.js';

const CODEX_TIMEOUT_MS = 15 * 60 * 1000;
export const CODEX_FAILURE_LOG = 'codex-failure.log';

/**
 * Head/tail kept from each captured stream. `codex exec` streams its reasoning
 * and tool output continuously, so an unbounded buffer holds multi-MB of
 * transcript for the whole 15-minute window — on the success path too, where
 * nothing ever reads it. The diagnostic value is at the ends: the head carries
 * a usage/flag error printed before any output file exists, the tail carries
 * whatever it was doing when it died.
 */
const CAPTURE_HEAD = 8 * 1024;
const CAPTURE_TAIL = 64 * 1024;

/** Bounded stream accumulator: keeps the head and the tail, elides the middle. Exported for tests. */
export function createCapture(
  headLimit = CAPTURE_HEAD,
  tailLimit = CAPTURE_TAIL,
): { push(chunk: string): void; value(): string } {
  let head = '';
  let tail = '';
  let elided = 0;
  return {
    push(chunk: string): void {
      if (head.length < headLimit) {
        const room = headLimit - head.length;
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (!chunk) return;
      tail += chunk;
      if (tail.length > tailLimit) {
        const over = tail.length - tailLimit;
        tail = tail.slice(over);
        elided += over;
      }
    },
    value(): string {
      return elided === 0 ? head + tail : `${head}\n…${elided} bytes elided…\n${tail}`;
    },
  };
}

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
 * - exit 0 with output → findings as parsed, no error.
 * - exit 0 with NO output → errored. `codex exec` is contracted to print `[]`
 *   when it finds nothing, so an empty result means the output file was never
 *   written or could not be read. Reporting that as a clean "found nothing" is
 *   the same class of bug this tool fixes on the posting side: an unknown
 *   outcome presented as a known-good one, here costing a whole reviewer
 *   silently.
 * - nonzero exit (or timeout) with NO findings → errored run, empty findings.
 * - nonzero exit (or timeout) WITH findings → findings are kept (partial output
 *   is still useful) but `error` is set so the run is never reported as clean.
 */
export function mapCodexResult(args: {
  exitCode: number;
  timedOut: boolean;
  raw: string;
  durationMs: number;
  /** Why the output file could not be read, when it could not. */
  readError?: string;
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
  if (args.exitCode === 0 && !args.timedOut) {
    if (args.raw.trim()) return base;
    return {
      ...base,
      error: `codex exec exited 0 but wrote no output${args.readError ? ` (${args.readError})` : ''}`,
    };
  }
  const cause = args.timedOut ? 'timed out' : `exited ${args.exitCode}`;
  return {
    ...base,
    error:
      findings.length > 0
        ? `codex exec ${cause} — kept ${findings.length} finding(s), output may be incomplete`
        : `codex exec ${cause}`,
  };
}

/** The failure log body. Pure and exported so its content is testable without spawning. */
export function formatCodexFailureLog(a: {
  error: string;
  argv: string[];
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}): string {
  return [
    a.error,
    `argv: ${JSON.stringify(a.argv)}`,
    `exit: ${a.exitCode}  timedOut: ${a.timedOut}  durationMs: ${a.durationMs}`,
    ``,
    `--- stderr ---`,
    a.stderr,
    ``,
    `--- stdout ---`,
    a.stdout,
  ].join('\n');
}

/**
 * Second-opinion reviewer running on the Codex CLI, in parallel with the main
 * orchestrator session. A different model family catches what the primary one
 * misses. Read-only sandbox; output captured via --output-last-message.
 *
 * Resolves on EVERY failure path — including a synchronous spawn rejection —
 * so a broken sibling costs one reviewer, never the review.
 */
export async function runCodexReviewer(opts: CodexReviewOptions): Promise<ReviewerOutput> {
  const start = Date.now();
  const outFile = resolve(opts.outDir, 'codex-output.txt');
  const prompt =
    `You are an adversarial second-opinion code reviewer. Read the PR review context at \`${opts.contextPath}\` (metadata, existing comments, diff).${skillsRulesSentence(opts.skillsPath)} ` +
    `Hunt for real bugs, security issues, and broken edge cases the diff introduces — assume other reviewers already caught the obvious; look for what they would miss. Do not restate existing comments. ` +
    `Output ONLY a JSON array of findings using the shape: ${OUTPUT_SHAPE}. If you find nothing, output []. No prose. No fences.`;

  const binary = opts.binary ?? 'codex';
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
    const stderrCap = createCapture();
    const stdoutCap = createCapture();
    let child;
    try {
      // stdout is captured, not ignored: a usage/flag error from `codex exec`
      // prints there and exits before any output file is written, which is the
      // one failure mode that leaves nothing at all to diagnose.
      child = spawnCli(binary, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      // spawnCli validates argv SYNCHRONOUSLY on win32 (assertSafeArg over
      // SAFE_ARG_RE), so a run dir with a character outside that set — a
      // non-ASCII Windows profile path — throws right here. Catching it inside
      // the executor is what lets the failure travel the normal path and reach
      // codex-failure.log; letting it reject would strand it as one stderr line.
      res({ exitCode: -1, timedOut: false, stderr: (err as Error).message, stdout: '' });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // best-effort
      }
    }, opts.timeoutMs ?? CODEX_TIMEOUT_MS);

    // A child that rejected a flag and exited already makes this write EPIPE.
    // `child.on('error')` covers spawn failures only, so an unhandled stream
    // error would become an uncaught exception and take the review down.
    child.stdin.on('error', (err: Error) => stderrCap.push(`\n[stdin] ${err.message}\n`));
    child.stderr.on('data', (c: Buffer) => stderrCap.push(c.toString('utf8')));
    child.stdout.on('data', (c: Buffer) => stdoutCap.push(c.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      res({ exitCode: -1, timedOut, stderr: `${stderrCap.value()}\n${err.message}`, stdout: stdoutCap.value() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ exitCode: code ?? -1, timedOut, stderr: stderrCap.value(), stdout: stdoutCap.value() });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });

  let raw = '';
  let readError: string | undefined;
  try {
    raw = readFileSync(outFile, 'utf8');
  } catch (err) {
    // Keep the reason: an absent output file is the whole story on an early exit.
    readError = (err as Error).message;
  }
  const output = mapCodexResult({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    raw,
    durationMs: Date.now() - start,
    readError,
  });

  if (output.error) {
    process.stderr.write(`[codex] ${output.error}: ${result.stderr.trim().slice(0, 300)}\n`);
    const logPath = resolve(opts.outDir, CODEX_FAILURE_LOG);
    try {
      writeFileSync(
        logPath,
        formatCodexFailureLog({
          error: output.error,
          argv: [binary, ...argv],
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: output.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
        'utf8',
      );
      // Inside the try: pointing at a file that was never written is a worse
      // dead end than the one this log exists to remove.
      process.stderr.write(`[codex] full output → ${logPath}\n`);
    } catch (err) {
      // A logging failure must never mask the reviewer's own error — but it
      // must not be silent either, or the operator chases a missing file.
      process.stderr.write(`[codex] could not write ${CODEX_FAILURE_LOG}: ${(err as Error).message}\n`);
    }
  }
  return output;
}
