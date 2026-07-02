import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GatherOutput, ReviewerOutput, SkillDefinition } from '../types.js';
import { matchesAny } from '../util/globs.js';

const BUILTIN_AGENTS = [
  'pr-review:security',
  'pr-review:quality',
  'pr-review:architecture',
  'pr-review:performance',
  'pr-review:test-coverage',
  'pr-review:silent-failure',
] as const;
const VERIFIER_AGENT = 'pr-review:verifier';

const COMPANION_DISPATCH = [
  {
    pluginId: 'pr-review-toolkit',
    agents: [
      'pr-review-toolkit:code-reviewer',
      'pr-review-toolkit:code-simplifier',
      'pr-review-toolkit:comment-analyzer',
      'pr-review-toolkit:pr-test-analyzer',
      'pr-review-toolkit:silent-failure-hunter',
      'pr-review-toolkit:type-design-analyzer',
    ],
  },
] as const;

const COMPANION_SLASH = [
  { pluginId: 'code-review', command: '/code-review:code-review' },
] as const;

export interface SingleSessionOptions {
  prUrl: string;
  gather: GatherOutput;
  skills: SkillDefinition[];
  installedCompanions: string[];
  skipReviewers: string[];
  outDir: string;
  copilotBinary?: string;
  defaultModel?: string;
  timeoutMs?: number;
  invokeCompanions: boolean;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function writeContextFile(opts: SingleSessionOptions): string {
  const { gather, skills, outDir } = opts;
  const inScope = gather.changedFiles.filter((f) => !f.excluded);
  const metaLines: string[] = [
    `# PR Review Context`,
    ``,
    `## Pull Request`,
    `- **URL:** ${opts.prUrl}`,
    `- **Title:** ${gather.metadata.title}`,
    `- **Author:** ${gather.metadata.author}`,
    `- **Branch:** ${gather.metadata.headBranch} → ${gather.metadata.baseBranch}`,
    `- **Head SHA:** ${gather.metadata.headSha.slice(0, 12)}`,
    `- **Labels:** ${gather.metadata.labels.length ? gather.metadata.labels.join(', ') : '(none)'}`,
    `- **Draft:** ${gather.metadata.isDraft ? 'yes' : 'no'}`,
    `- **State:** ${gather.metadata.state}`,
    ``,
    `## Description`,
    gather.metadata.description.trim() || '_(no description)_',
    ``,
    `## Linked Work Items`,
    gather.metadata.linkedItems.length
      ? gather.metadata.linkedItems
          .map((l) => `- ${l.type} #${l.id}: ${l.title ?? '<no title>'} (${l.state ?? 'unknown'})`)
          .join('\n')
      : '_(none)_',
    ``,
    `## Existing Comments (DO NOT duplicate these findings)`,
  ];
  if (gather.existingComments.length === 0) {
    metaLines.push('_(none)_');
  } else {
    for (const c of gather.existingComments) {
      const loc = c.file ? ` (${c.file}${c.line ? `:${c.line}` : ''})` : '';
      metaLines.push(`- **${c.author}** [${c.source}]${loc}: ${c.body.replace(/\s+/g, ' ').slice(0, 320)}`);
    }
  }

  metaLines.push('', `## Project-Specific Context (Skills)`);
  if (skills.length === 0) {
    metaLines.push('_(none)_');
  } else {
    for (const s of skills) {
      metaLines.push('', `### ${s.name}`, s.description ? `_${s.description}_` : '', '', s.body.trim());
    }
  }

  metaLines.push('', `## Changed Files (${inScope.length} in scope, ${gather.changedFiles.length - inScope.length} excluded)`);
  for (const f of inScope) {
    metaLines.push(`- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`);
  }

  metaLines.push('', `## Diff`);
  for (const f of inScope) {
    if (!f.patch) continue;
    metaLines.push('', `### ${f.path}`, '', '```diff', f.patch, '```');
  }

  const contextPath = join(outDir, 'pr-context.md');
  mkdirSync(dirname(contextPath), { recursive: true });
  writeFileSync(contextPath, metaLines.join('\n'), 'utf8');
  return contextPath;
}

function buildOrchestratorPrompt(
  opts: SingleSessionOptions,
  contextPath: string,
  findingsPath: string,
): string {
  const skip = new Set(opts.skipReviewers);
  const reviewerAgents = BUILTIN_AGENTS.filter((a) => !skip.has(agentToShortName(a)));
  const wantVerifier = !skip.has('verifier');

  const companionDispatchLines: string[] = [];
  const companionSlashLines: string[] = [];
  if (opts.invokeCompanions) {
    for (const c of COMPANION_DISPATCH) {
      if (!opts.installedCompanions.includes(c.pluginId)) continue;
      for (const agent of c.agents) {
        const shortAgent = agent.replace(/^[^:]+:/, '');
        companionDispatchLines.push(
          `- task(agent_type="${agent}", prompt="Read the PR context at \`${contextPath}\`. Apply your specific review lens. Output ONLY a JSON array of findings using the shape: [{\"severity\":\"CRITICAL|HIGH|MEDIUM|LOW|NIT\",\"title\":\"...\",\"body\":\"...\",\"file\":\"...\",\"line\":<int>}]. If you find nothing, output []. No prose. No fences.") — record as reviewer name \`companion:${c.pluginId}/${shortAgent}\``,
        );
      }
    }
    for (const c of COMPANION_SLASH) {
      if (!opts.installedCompanions.includes(c.pluginId)) continue;
      companionSlashLines.push(
        `- task(agent_type="general-purpose", prompt="Invoke the slash command \`${c.command} ${opts.prUrl}\`. Capture its output. Parse any structured findings into a JSON array using shape [{\"severity\":\"...\",\"title\":\"...\",\"body\":\"...\",\"file\":\"...\",\"line\":<int>}]. If no findings, output []. Output ONLY the JSON array.") — record as reviewer name \`companion:${c.pluginId}\``,
      );
    }
  }

  const reviewerDispatchLines = reviewerAgents.map((a) => {
    const short = agentToShortName(a);
    return `- task(agent_type="${a}", prompt="Read the PR context at \`${contextPath}\`. Apply your review criteria. Output ONLY a JSON array of findings using the shape: [{\"severity\":\"CRITICAL|HIGH|MEDIUM|LOW|NIT\",\"title\":\"...\",\"body\":\"...\",\"file\":\"...\",\"line\":<int>}]. If you find nothing, output []. No prose. No fences.") — record as reviewer name \`${short}\``;
  });

  const allParallel = [...reviewerDispatchLines, ...companionDispatchLines, ...companionSlashLines];

  const lines = [
    `You are the pr-review orchestrator. Your ONLY job is to coordinate a comprehensive pull request review by dispatching specialized subagents in parallel, collecting their JSON findings, then writing a single consolidated JSON file.`,
    ``,
    `## Input`,
    `- PR context: \`${contextPath}\` (already prepared by the Node CLI; do not refetch or modify)`,
    ``,
    `## Phase 1 — Parallel reviewer dispatch`,
    ``,
    `Use the \`task\` tool to launch ALL of the following in parallel. Do not wait between them; dispatch them as a batch:`,
    ``,
    ...allParallel,
    ``,
    `Each subagent returns a JSON array of findings (possibly empty: \`[]\`). Collect every array along with the reviewer name shown after the \`—\`.`,
  ];

  if (wantVerifier) {
    lines.push(
      ``,
      `## Phase 2 — Verifier (after Phase 1 completes)`,
      ``,
      `Once ALL Phase 1 subagents return, dispatch the verifier with the collected findings as context:`,
      ``,
      `- task(agent_type="${VERIFIER_AGENT}", prompt="Read the PR context at \`${contextPath}\`. Here are the findings from other reviewers (JSON): <inject collected findings JSON here>. Output ONLY a JSON array of cross-cutting issues, contradictions, or gaps that the other reviewers missed. Use shape [{\"severity\":\"...\",\"title\":\"...\",\"body\":\"...\",\"file\":\"...\",\"line\":<int>}]. If nothing to add, output [].") — record as reviewer name \`verifier\``,
    );
  }

  lines.push(
    ``,
    `## Phase 3 — Write the consolidated output file`,
    ``,
    `Write the final result to: \`${findingsPath}\``,
    ``,
    `Exact JSON shape (use Write or apply_patch tool — no shell redirection):`,
    ``,
    '```json',
    `{`,
    `  "reviewers": [`,
    `    { "name": "security",  "findings": [ <security agent's array> ] },`,
    `    { "name": "quality",   "findings": [ <quality agent's array> ] },`,
    `    ...`,
    `    { "name": "companion:pr-review-toolkit/code-reviewer", "findings": [...] },`,
    `    ...`,
    `    { "name": "verifier",  "findings": [ <verifier's array> ] }`,
    `  ]`,
    `}`,
    '```',
    ``,
    `Critical rules for Phase 3:`,
    `- Do NOT modify, re-rank, or summarize findings. Copy them verbatim from each subagent's output into the array under its reviewer name.`,
    `- If a subagent returned non-JSON, store its raw output as a single finding with severity "LOW", title "Unparseable output from <name>", and body = the raw output.`,
    `- Include EVERY reviewer that was dispatched, even ones with empty arrays.`,
    `- After writing the file, reply with the single word \`DONE\`. Nothing else.`,
  );

  return lines.join('\n');
}

function agentToShortName(agentType: string): string {
  return agentType.replace(/^pr-review:/, '');
}

export interface SingleSessionResult {
  outputs: ReviewerOutput[];
  rawOrchestratorOutput: string;
  rawOrchestratorStderr: string;
  exitCode: number;
  durationMs: number;
}

export async function runSingleSession(opts: SingleSessionOptions): Promise<SingleSessionResult> {
  const start = Date.now();
  mkdirSync(opts.outDir, { recursive: true });
  const contextPath = resolve(opts.outDir, 'pr-context.md');
  const findingsPath = resolve(opts.outDir, 'single-session-findings.json');

  writeContextFile({ ...opts, outDir: opts.outDir });
  const orchestratorPrompt = buildOrchestratorPrompt(opts, contextPath, findingsPath);
  const orchestratorPath = resolve(opts.outDir, 'orchestrator-prompt.md');
  writeFileSync(orchestratorPath, orchestratorPrompt, 'utf8');

  try {
    if (require('node:fs').existsSync(findingsPath)) {
      require('node:fs').unlinkSync(findingsPath);
    }
  } catch {
    // ignore
  }

  const model = opts.defaultModel ?? 'claude-opus-4.8';
  process.stderr.write(
    `[single-session] dispatching orchestrator (${BUILTIN_AGENTS.length} built-in agents, ` +
      `companions=${opts.invokeCompanions ? 'on' : 'off'}, model=${model})\n`,
  );

  const childResult = await spawnCopilot({
    binary: opts.copilotBinary ?? 'copilot',
    model,
    promptBody: orchestratorPrompt,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    addDir: opts.outDir,
  });

  const durationMs = Date.now() - start;

  let outputs: ReviewerOutput[] = [];
  try {
    const findingsRaw = readFileSync(findingsPath, 'utf8');
    const parsed = JSON.parse(findingsRaw) as {
      reviewers?: Array<{ name: string; findings: ReviewerOutput['findings'] }>;
    };
    outputs = (parsed.reviewers ?? []).map((r) => ({
      reviewerName: r.name,
      model,
      findings: r.findings ?? [],
      rawOutput: '',
      durationMs,
      exitCode: childResult.exitCode,
    }));
  } catch (err) {
    process.stderr.write(
      `[single-session] failed to parse ${findingsPath}: ${(err as Error).message}\n`,
    );
  }

  if (outputs.length === 0 && childResult.exitCode === 0) {
    process.stderr.write(
      `[single-session] orchestrator finished but no findings file produced; raw stdout follows\n` +
        childResult.stdout.slice(-2000) +
        '\n',
    );
  }

  return {
    outputs,
    rawOrchestratorOutput: childResult.stdout,
    rawOrchestratorStderr: childResult.stderr,
    exitCode: childResult.exitCode,
    durationMs,
  };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnCopilot(args: {
  binary: string;
  model: string;
  promptBody: string;
  timeoutMs: number;
  addDir: string;
}): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const argv = [
      '--model',
      args.model,
      '--allow-all-tools',
      '--no-ask-user',
      '--add-dir',
      args.addDir,
      '-s',
    ];
    const child = spawn(args.binary, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    child.stdin.write(args.promptBody);
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
    }, args.timeoutMs);

    const heartbeatStart = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedS = Math.round((Date.now() - heartbeatStart) / 1000);
      process.stderr.write(`[single-session] orchestrator running… ${elapsedS}s elapsed\n`);
    }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      resolve({
        stdout,
        stderr: stderr + (timedOut ? '\n[timed out]' : ''),
        exitCode: code ?? -1,
      });
    });
  });
}
