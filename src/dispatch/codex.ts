import { execFile, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReviewerOutput } from '../types.js';
import { parseReviewerOutput } from './parsers.js';

const CODEX_TIMEOUT_MS = 15 * 60 * 1000;

export function detectCodex(binary = 'codex'): Promise<boolean> {
  return new Promise((res) => {
    execFile(
      binary,
      ['--version'],
      // shell on win32: codex installs as a .cmd shim, invisible to a raw execFile
      { timeout: 10_000, windowsHide: true, shell: process.platform === 'win32' },
      (err) => res(!err),
    );
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
 * Second-opinion reviewer running on the Codex CLI, in parallel with the main
 * orchestrator session. A different model family catches what the primary one
 * misses. Read-only sandbox; output captured via --output-last-message.
 */
export async function runCodexReviewer(opts: CodexReviewOptions): Promise<ReviewerOutput> {
  const start = Date.now();
  const outFile = resolve(opts.outDir, 'codex-output.txt');
  const rules = opts.skillsPath
    ? ` Also read the project-specific rules at \`${opts.skillsPath}\` — they are authoritative and OVERRIDE generic judgement.`
    : '';
  const prompt =
    `You are an adversarial second-opinion code reviewer. Read the PR review context at \`${opts.contextPath}\` (metadata, existing comments, diff).${rules} ` +
    `Hunt for real bugs, security issues, and broken edge cases the diff introduces — assume other reviewers already caught the obvious; look for what they would miss. Do not restate existing comments. ` +
    `Output ONLY a JSON array of findings using the shape: [{"severity":"CRITICAL|HIGH|MEDIUM|LOW|NIT","title":"...","body":"...","file":"...","line":<int>}]. If you find nothing, output []. No prose. No fences.`;

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

  const result = await new Promise<{ exitCode: number; stderr: string }>((res) => {
    const child = spawn(opts.binary ?? 'codex', argv, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.stdin.write(prompt);
    child.stdin.end();
    let stderr = '';
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
    child.on('error', (err) => {
      clearTimeout(timer);
      res({ exitCode: -1, stderr: stderr + '\n' + err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ exitCode: code ?? -1, stderr: stderr + (timedOut ? '\n[timed out]' : '') });
    });
  });

  let raw = '';
  try {
    raw = readFileSync(outFile, 'utf8');
  } catch {
    // no output file — treated as an errored run below
  }
  const findings = raw ? parseReviewerOutput(raw, 'json') : [];
  const durationMs = Date.now() - start;
  if (result.exitCode !== 0 && findings.length === 0) {
    process.stderr.write(`[codex] reviewer failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}\n`);
    return {
      reviewerName: 'codex',
      model: 'codex',
      findings: [],
      rawOutput: raw,
      durationMs,
      exitCode: result.exitCode,
      error: `codex exec failed (exit ${result.exitCode})`,
    };
  }
  return {
    reviewerName: 'codex',
    model: 'codex',
    findings,
    rawOutput: raw,
    durationMs,
    exitCode: result.exitCode,
  };
}
