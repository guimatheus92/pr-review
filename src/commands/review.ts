import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGather } from './gather.js';
import { runPost } from './post.js';
import { loadAll } from '../plugins/loader.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { prepareSessionContext, runSingleSession } from '../dispatch/single-session.js';
import { resolveRuntime } from '../dispatch/runtime.js';
import { detectCodex, runCodexReviewer } from '../dispatch/codex.js';
import { ensureRunDir } from '../util/tmp.js';
import { detectProvider } from '../providers/index.js';
import { dedupeAgainstExisting, dedupeWithinBatch } from '../dedupe.js';
import { detectCompanions, formatWarning } from '../plugins/companions.js';
import type { Finding, GatherOutput, ReviewerOutput, Severity } from '../types.js';

function sanitizeForFilename(name: string): string {
  return name.replace(/[\\\/:*?"<>|]/g, '_');
}

interface ReviewCmdOptions {
  prUrl: string;
  skip?: string[];
  reviewers?: string[];
  reviewersDirs?: string[];
  skills?: string[];
  skillsDirs?: string[];
  plugins?: string[];
  pluginDirs?: string[];
  dryRun?: boolean;
  publish?: boolean;
  copilotBinary?: string;
  useCache?: boolean;
  autodiscover?: boolean;
  dedupeMode?: 'strict' | 'loose' | 'off';
  defaultModel?: string;
  noCompanionWarning?: boolean;
  withCompanions?: boolean;
  /** Prepare pr-context.md + per-reviewer skills files, print the routing, and exit without spawning copilot. */
  contextOnly?: boolean;
  language?: string;
  failOn?: Severity;
  runtime?: 'copilot' | 'claude' | 'auto';
  withCodex?: boolean;
}

export interface ReviewResult {
  outputs: ReviewerOutput[];
  summary: string;
  /** 0 = clean; 1 = findings at/above --fail-on; 2 = pipeline failure (no parseable findings). */
  exitCode: 0 | 1 | 2;
}

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  NIT: 4,
};


const MAX_FILES_GUARD = 500;
const MAX_PATCH_BYTES = 2_000_000;

/**
 * The three-state exit contract, exported for tests: 2 = pipeline failure
 * (wins over everything — no parseable findings is never a clean PR),
 * 1 = findings at/above --fail-on survived dedupe, 0 = clean.
 */
export function decideExitCode(
  findingsUnavailable: boolean,
  finalFindings: Finding[],
  failOn?: Severity,
): 0 | 1 | 2 {
  if (findingsUnavailable) return 2;
  if (!failOn) return 0;
  const threshold = SEVERITY_RANK[failOn] ?? 0;
  return finalFindings.some((f) => (SEVERITY_RANK[f.severity] ?? 99) <= threshold) ? 1 : 0;
}

function earlyExitGate(gather: GatherOutput): string | null {
  const m = gather.metadata;
  if (!m.title.trim()) return 'PR has no title — author needs to fill it in before review.';
  if (m.description.trim().length < 10) {
    return `PR description is missing or too short (${m.description.trim().length} chars). Please write a brief description of what changed and why.`;
  }
  const inScope = gather.changedFiles.filter((f) => !f.excluded);
  if (inScope.length === 0) {
    return 'No reviewable files (everything excluded by diff filters). Nothing to review.';
  }
  if (inScope.length > MAX_FILES_GUARD) {
    return `PR is too large: ${inScope.length} changed files (limit ${MAX_FILES_GUARD}). Split into smaller PRs.`;
  }
  const totalBytes = inScope.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
  if (totalBytes > MAX_PATCH_BYTES) {
    return `PR diff is too large: ${(totalBytes / 1024 / 1024).toFixed(1)} MB of patches (limit ${MAX_PATCH_BYTES / 1024 / 1024} MB). Split into smaller PRs.`;
  }
  return null;
}

function renderSummary(
  prUrl: string,
  outputs: ReviewerOutput[],
  finalFindings: Finding[],
  droppedCount: number,
  elapsedMs: number,
  postResult?: { posted: number; attempted: number; skipped: number; errors: { error: string }[] },
): string {
  const totalRaw = outputs.reduce((n, o) => n + o.findings.length, 0);
  const lines: string[] = [
    `# PR Review Summary`,
    ``,
    `**PR:** ${prUrl}`,
    `**Elapsed:** ${(elapsedMs / 1000).toFixed(1)}s`,
    `**Reviewers run:** ${outputs.length} | **Raw findings:** ${totalRaw} | **After dedupe:** ${finalFindings.length} | **Dropped:** ${droppedCount}`,
  ];
  if (postResult) {
    lines.push(
      `**Posted:** ${postResult.posted} / ${postResult.attempted} attempted; ${postResult.skipped} skipped; ${postResult.errors.length} errors`,
    );
  }
  lines.push(``, `| Reviewer | Findings | Status |`, `|---|---|---|`);
  for (const o of outputs) {
    const status = o.exitCode === 0 && !o.error ? '✓' : o.error ? `✗ ${o.error}` : `✗ exit ${o.exitCode}`;
    lines.push(`| ${o.reviewerName} | ${o.findings.length} | ${status} |`);
  }
  lines.push('');

  const sorted = finalFindings
    .slice()
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99));

  if (sorted.length === 0) {
    lines.push(`## Findings`, ``, '_No findings after deduplication._');
  } else {
    lines.push(`## Findings`);
    for (const f of sorted) {
      lines.push(``, '---', ``, f.body);
    }
  }

  return lines.join('\n');
}

export async function runReview(opts: ReviewCmdOptions): Promise<ReviewResult> {
  const overallStart = Date.now();
  const cwd = process.cwd();
  const provider = detectProvider(opts.prUrl);
  const ref = provider.parseUrl(opts.prUrl);
  const outDir = ensureRunDir(ref ?? undefined);
  process.stderr.write(`[review] run artifacts → ${outDir}\n`);

  const cliOverrides: ConfigOverrides = {};
  if (opts.reviewers) cliOverrides.reviewers = opts.reviewers;
  if (opts.reviewersDirs) cliOverrides.reviewersDirs = opts.reviewersDirs;
  if (opts.skills) cliOverrides.skills = opts.skills;
  if (opts.skillsDirs) cliOverrides.skillsDirs = opts.skillsDirs;
  if (opts.plugins) cliOverrides.plugins = opts.plugins;
  if (opts.pluginDirs) cliOverrides.pluginDirs = opts.pluginDirs;
  if (opts.skip) cliOverrides.skipReviewers = opts.skip;
  if (opts.defaultModel) cliOverrides.defaultModel = opts.defaultModel;
  if (typeof opts.autodiscover === 'boolean') cliOverrides.autodiscover = opts.autodiscover;
  if (opts.dedupeMode) cliOverrides.dedupeMode = opts.dedupeMode;
  if (typeof opts.withCompanions === 'boolean') cliOverrides.invokeCompanions = opts.withCompanions;
  if (opts.language) cliOverrides.language = opts.language;
  if (opts.runtime) cliOverrides.runtime = opts.runtime;
  if (typeof opts.withCodex === 'boolean') cliOverrides.invokeCodex = opts.withCodex;

  const { config } = loadConfig({ cwd, cliOverrides });

  const runtime = resolveRuntime(config.runtime, opts.copilotBinary);
  process.stderr.write(`[review] runtime: ${runtime}\n`);

  const wantCodex = config.invokeCodex && !(opts.skip ?? []).includes('codex');
  let codexAvailable = false;
  const codexDetectPromise = wantCodex
    ? detectCodex().then((ok) => {
        codexAvailable = ok;
      })
    : Promise.resolve();

  let installedCompanions: string[] = [];
  let companionPromise: Promise<void> = Promise.resolve();
  if (config.invokeCompanions || config.companionWarn) {
    companionPromise = (async () => {
      try {
        const state = await detectCompanions(opts.copilotBinary, runtime);
        installedCompanions = state.installed;
        if (state.missing.length > 0 && config.companionWarn && !opts.noCompanionWarning) {
          const warn = formatWarning(state.missing);
          if (warn) process.stderr.write(warn + '\n');
        }
      } catch (err) {
        process.stderr.write(`[companions] detection failed: ${(err as Error).message}\n`);
      }
    })();
  }

  const gather = await runGather({
    prUrl: opts.prUrl,
    useCache: opts.useCache,
    extraExcludes: config.diffExcludes,
  });
  writeFileSync(join(outDir, 'pr-review-gather.json'), JSON.stringify(gather, null, 2), 'utf8');

  const earlyExitReason = earlyExitGate(gather);
  if (earlyExitReason) {
    process.stderr.write(`[review] early exit: ${earlyExitReason}\n`);
    const summary = [
      `# PR Review Summary`,
      ``,
      `**PR:** ${opts.prUrl}`,
      ``,
      `**Early exit — review aborted.**`,
      ``,
      earlyExitReason,
    ].join('\n');
    writeFileSync(join(outDir, 'pr-review-summary.md'), summary, 'utf8');
    return { outputs: [], summary, exitCode: 0 };
  }

  await Promise.all([companionPromise, codexDetectPromise]);
  const includeCodex = wantCodex && codexAvailable;
  if (wantCodex && !codexAvailable) {
    process.stderr.write(`[codex] codex CLI not found on PATH — skipping the second-opinion reviewer\n`);
  }

  // Single-session mode dispatches runtime-registered agents only; user-authored
  // context goes in skills, so reviewer .md loading is skipped entirely.
  const loaded = loadAll({ cwd, config, skillsOnly: true });
  process.stderr.write(`[review] loaded ${loaded.skills.length} skill(s)\n`);

  const sessionOpts = {
    prUrl: opts.prUrl,
    gather,
    skills: loaded.skills,
    installedCompanions,
    skipReviewers: opts.skip?.length ? opts.skip : config.skipReviewers,
    outDir,
    copilotBinary: opts.copilotBinary,
    defaultModel: config.defaultModel,
    invokeCompanions: config.invokeCompanions,
    language: config.language,
    runtime,
    includeCodex,
  };

  if (opts.contextOnly) {
    const ctx = prepareSessionContext(sessionOpts);
    const lines: string[] = [
      `# PR Review Context Preview`,
      ``,
      `**Run dir:** ${outDir}`,
      `**Context file:** ${ctx.contextPath}`,
      `**Runtime:** ${runtime}`,
      `**Reviewers to dispatch:** ${ctx.dispatchedReviewers.join(', ') || '(none)'}${includeCodex ? ' + codex (sibling process)' : ''}`,
    ];
    if (ctx.triageSkipped.length > 0) {
      lines.push(`**Skipped by triage (docs-only PR):** ${ctx.triageSkipped.join(', ')}`);
    }
    lines.push(``, `## Skill routing`, ``);
    if (ctx.skillRouting.length === 0) {
      lines.push('_No skills loaded._');
    } else {
      lines.push(`| Skill | Injected into | Source |`, `|---|---|---|`);
      for (const r of ctx.skillRouting) {
        lines.push(`| ${r.skill} | ${r.targets.length ? r.targets.join(', ') : '(nobody — no matching files/reviewers)'} | ${r.source} |`);
      }
    }
    const summary = lines.join('\n');
    writeFileSync(join(outDir, 'pr-review-summary.md'), summary, 'utf8');
    return { outputs: [], summary, exitCode: 0 };
  }

  process.stderr.write(
    `[review] single-session dispatch: built-ins + verifier + ` +
      `${config.invokeCompanions ? `${installedCompanions.length} companion(s)` : '0 companions'}` +
      `${includeCodex ? ' + codex' : ''}\n`,
  );

  // Codex runs as a sibling process, in parallel with the orchestrator session.
  // runCodexReviewer resolves on every failure path (spawn error, timeout,
  // unreadable output) with `error` set — no catch wrapper needed.
  let codexPromise: Promise<ReviewerOutput> | null = null;
  if (includeCodex) {
    const ctx = prepareSessionContext(sessionOpts);
    codexPromise = runCodexReviewer({
      contextPath: ctx.contextPath,
      skillsPath: ctx.skillsFiles['codex'],
      outDir,
    });
  }

  const session = await runSingleSession(sessionOpts);

  const outputs = session.outputs;
  if (codexPromise) {
    const codexOut = await codexPromise;
    outputs.push(codexOut);
  }

  for (const out of outputs) {
    try {
      writeFileSync(
        join(outDir, `raw-${sanitizeForFilename(out.reviewerName)}.json`),
        JSON.stringify(out.findings, null, 2),
        'utf8',
      );
    } catch {
      // best-effort
    }
  }

  const rawFindings = outputs.flatMap((o) => o.findings);
  const intraBatch = dedupeWithinBatch(rawFindings);
  const dedupedAgainstExisting = dedupeAgainstExisting(intraBatch.kept, gather.existingComments, config.dedupeMode);
  const finalFindings = dedupedAgainstExisting.kept;
  const droppedCount = intraBatch.dropped.length + dedupedAgainstExisting.dropped.length;

  if (droppedCount > 0) {
    process.stderr.write(`[review] dedupe dropped ${droppedCount} finding(s) (${intraBatch.dropped.length} intra-batch, ${dedupedAgainstExisting.dropped.length} vs existing comments)\n`);
  }

  let postResult: Awaited<ReturnType<typeof runPost>> | undefined;
  if (opts.publish) {
    process.stderr.write(`[review] posting comments…\n`);
    const wrapper: ReviewerOutput[] = [
      {
        reviewerName: 'merged',
        model: '(single-session)',
        findings: finalFindings,
        rawOutput: '',
        durationMs: 0,
        exitCode: 0,
      },
    ];
    postResult = await runPost({ prUrl: opts.prUrl, outputs: wrapper, publish: true, gather });
  } else if (opts.dryRun) {
    process.stderr.write(`[review] --dry-run: skipping post\n`);
  }

  const summary = renderSummary(opts.prUrl, outputs, finalFindings, droppedCount, Date.now() - overallStart, postResult);
  writeFileSync(join(outDir, 'pr-review-summary.md'), summary, 'utf8');
  writeFileSync(
    join(outDir, 'pr-review-findings.json'),
    JSON.stringify(
      {
        reviewers: outputs.map((o) => ({ reviewer: o.reviewerName, findings: o.findings })),
        finalFindings,
        droppedCount,
      },
      null,
      2,
    ),
    'utf8',
  );

  process.stderr.write(`[review] wrote summary to ${join(outDir, 'pr-review-summary.md')}\n`);

  const exitCode = decideExitCode(session.findingsUnavailable, finalFindings, opts.failOn);
  if (exitCode === 2) {
    process.stderr.write(
      `[review] pipeline failure: the orchestrator produced no parseable findings (this is NOT a clean PR)\n`,
    );
  } else if (exitCode === 1) {
    process.stderr.write(`[review] --fail-on ${opts.failOn}: findings at/above threshold\n`);
  }
  return { outputs, summary, exitCode };
}
