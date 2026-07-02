import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGather } from './gather.js';
import { runPost } from './post.js';
import { loadAll } from '../plugins/loader.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { runSingleSession } from '../dispatch/single-session.js';
import { ensureRunDir } from '../util/tmp.js';
import { detectProvider } from '../providers/index.js';
import { dedupeAgainstExisting, dedupeWithinBatch } from '../dedupe.js';
import { detectCompanions, formatWarning } from '../plugins/companions.js';
import type { Finding, GatherOutput, ReviewerOutput } from '../types.js';

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
  useResponseCache?: boolean;
  autodiscover?: boolean;
  dedupeMode?: 'strict' | 'loose' | 'off';
  defaultModel?: string;
  noCompanionWarning?: boolean;
  withCompanions?: boolean;
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

export async function runReview(opts: ReviewCmdOptions): Promise<{ outputs: ReviewerOutput[]; summary: string }> {
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

  const { config } = loadConfig({ cwd, cliOverrides });

  let installedCompanions: string[] = [];
  let companionPromise: Promise<void> = Promise.resolve();
  if (config.invokeCompanions || config.companionWarn) {
    companionPromise = (async () => {
      try {
        const state = await detectCompanions(opts.copilotBinary);
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
    return { outputs: [], summary };
  }

  await companionPromise;

  const loaded = loadAll({ cwd, config });
  process.stderr.write(
    `[review] loaded ${loaded.skills.length} skill(s); ${loaded.reviewers.length} user reviewer(s) ` +
      `(user reviewers not yet supported in single-session mode; will be in a follow-up)\n`,
  );

  process.stderr.write(
    `[review] single-session dispatch: 6 built-in + verifier + ` +
      `${config.invokeCompanions ? `${installedCompanions.length} companion(s)` : '0 companions'}\n`,
  );

  const session = await runSingleSession({
    prUrl: opts.prUrl,
    gather,
    skills: loaded.skills,
    installedCompanions,
    skipReviewers: opts.skip ?? config.skipReviewers,
    outDir,
    copilotBinary: opts.copilotBinary,
    defaultModel: config.defaultModel,
    invokeCompanions: config.invokeCompanions,
  });

  const outputs = session.outputs;

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
    postResult = await runPost({ prUrl: opts.prUrl, outputs: wrapper, publish: true });
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
  return { outputs, summary };
}
