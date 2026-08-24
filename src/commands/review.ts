import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGather } from './gather.js';
import { runPost } from './post.js';
import { loadAll } from '../plugins/loader.js';
import { loadConfig, type ConfigOverrides } from '../config.js';
import { parseFindingsFile, prepareSessionContext, REVIEWER_OUTPUT_FILES, runSingleSession } from '../dispatch/single-session.js';
import { selectPasses, type PassRoute } from '../dispatch/pass-select.js';
import { ensurePacks } from '../packs/sync.js';
import { loadLinguist } from '../stack/linguist.js';
import { detectStack } from '../stack/detect.js';
import { resolveRuntime, type Runtime, type RuntimeChoice } from '../dispatch/runtime.js';
import { detectCodex, runCodexReviewer } from '../dispatch/codex.js';
import { ensureRunDir, ERROR_FILE, RUNS_ROOT, sanitizeForFilename } from '../util/tmp.js';
import { appendProgress } from '../util/progress.js';
import { readPostedMarker, writePostedMarker } from '../util/posted-marker.js';
import { withRetry } from '../util/retry.js';
import { resolvePr } from '../providers/index.js';
import { dedupeAgainstExisting, dedupeWithinBatch } from '../dedupe.js';
import { detectCompanions, formatWarning } from '../plugins/companions.js';
import type { PrProvider } from '../providers/types.js';
import type { Finding, GatherOutput, ReviewerOutput, Severity } from '../types.js';

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
  runtime?: RuntimeChoice;
  withCodex?: boolean;
  /** Use this exact run dir instead of minting a new one (set by the --detach parent). */
  runDir?: string;
  /** Resume a prior run by id: reuse its gather + reviewer outputs, skip dispatch. */
  resumeRunId?: string;
  /** Re-post even if this run already has a posted.marker. */
  forcePost?: boolean;
  /** Test seam — when omitted, resolved via detectProvider(prUrl): in runReview for a fresh run, in runPost on --resume. */
  provider?: PrProvider;
  /** Eval hook: read the gather JSON from this file instead of the provider APIs. Requires --dry-run. */
  fromGather?: string;
  /** Test seam — replaces the pass-selection step. */
  selectPassesFn?: typeof selectPasses;
  /** Test seam — isolates config/packs/Linguist from the developer's real home dir. */
  homeOverride?: string;
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

/**
 * Render the pass routing as both a compact one-liner (`brief`, for the live
 * progress feed) and the full `## Skills` markdown section: which skills ran as
 * their own pass (and why they matched), which sit in the on-demand index, and
 * which were skipped.
 */
export function summarizePasses(routing: PassRoute[]): { section: string[]; brief: string } {
  const ran = routing.filter((r) => r.matchedBy !== 'index' && r.matchedBy !== 'skipped' && r.matchedBy !== 'context');
  const context = routing.filter((r) => r.matchedBy === 'context');
  const index = routing.filter((r) => r.matchedBy === 'index');
  const skipped = routing.filter((r) => r.matchedBy === 'skipped');

  const brief = `${ran.length} pass(es)${context.length ? ` · ${context.length} project rule(s)` : ''} · ${index.length} on-demand`;
  const section = [
    `## Skills`,
    ``,
    `**Passes:** ${ran.length}${context.length ? ` · **Project rules (in every pass):** ${context.length}` : ''} · **On-demand (index):** ${index.length}${skipped.length ? ` · **Skipped:** ${skipped.length}` : ''}`,
  ];
  if (ran.length > 0) {
    section.push(``, `| Pass | Matched by |`, `|---|---|`);
    for (const r of ran) section.push(`| ${r.name} | ${r.matchedBy} |`);
  }
  if (context.length > 0) {
    section.push(``, `_Project rules injected into every pass: ${context.map((r) => r.name).join(', ')}._`);
  }
  if (index.length > 0) {
    // Make clear that indexed ≠ ignored — passes read the relevant ones on demand.
    section.push(
      ``,
      `_${index.length} skill(s) listed in skills-index.md — passes open the relevant ones as needed; not ignored._`,
    );
  }
  section.push('');
  return { section, brief };
}

export function renderSummary(
  prUrl: string,
  outputs: ReviewerOutput[],
  finalFindings: Finding[],
  droppedCount: number,
  elapsedMs: number,
  postResult?: { posted: number; attempted: number; skipped: number; errors: { error: string }[]; verified?: boolean },
  passRouting?: PassRoute[],
  degraded?: string[],
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
    if (postResult.verified === false) {
      // The counts above decide whether the reader reaches for --resume, so an
      // unverified run has to say so where the counts are, not only in stderr.
      lines.push(
        ``,
        `> **Unverified:** the PR could not be read back, so at least one write's outcome is unknown. Check the PR before re-running with \`--resume\` (which will refuse without \`--force-post\`).`,
      );
    }
  }
  lines.push(``, `| Reviewer | Findings | Status |`, `|---|---|---|`);
  for (const o of outputs) {
    const status = o.exitCode === 0 && !o.error ? '✓' : o.error ? `✗ ${o.error}` : `✗ exit ${o.exitCode}`;
    lines.push(`| ${o.reviewerName} | ${o.findings.length} | ${status} |`);
  }
  lines.push('');

  if (degraded && degraded.length > 0) {
    lines.push(
      ``,
      `> **Degraded:** ${degraded.length} pack/baseline warning(s) — coverage may be reduced:`,
      ...degraded.map((d) => `> - ${d}`),
    );
  }

  if (passRouting) lines.push(...summarizePasses(passRouting).section);

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

function toConfigOverrides(opts: ReviewCmdOptions): ConfigOverrides {
  const o: ConfigOverrides = {};
  if (opts.reviewers) o.reviewers = opts.reviewers;
  if (opts.reviewersDirs) o.reviewersDirs = opts.reviewersDirs;
  if (opts.skills) o.skills = opts.skills;
  if (opts.skillsDirs) o.skillsDirs = opts.skillsDirs;
  if (opts.plugins) o.plugins = opts.plugins;
  if (opts.pluginDirs) o.pluginDirs = opts.pluginDirs;
  if (opts.skip) o.skipReviewers = opts.skip;
  if (opts.defaultModel) o.defaultModel = opts.defaultModel;
  if (typeof opts.autodiscover === 'boolean') o.autodiscover = opts.autodiscover;
  if (opts.dedupeMode) o.dedupeMode = opts.dedupeMode;
  if (typeof opts.withCompanions === 'boolean') o.invokeCompanions = opts.withCompanions;
  if (opts.language) o.language = opts.language;
  if (opts.runtime) o.runtime = opts.runtime;
  if (typeof opts.withCodex === 'boolean') o.invokeCodex = opts.withCodex;
  return o;
}

/**
 * Persist the orchestrator's FULL stdout/stderr on a pipeline failure — when
 * the contract fails, stdout may hold the only copy of the reviewer findings,
 * and a tail would make even manual salvage impossible. Exported for tests.
 */
export function writeOrchestratorFailureLog(outDir: string, exitCode: number | null, stdout: string, stderr: string): void {
  try {
    const failLog = join(outDir, 'orchestrator-failure.log');
    writeFileSync(failLog, `exitCode=${exitCode}\n\n=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}\n`, 'utf8');
    process.stderr.write(`[review] wrote orchestrator failure log to ${failLog}\n`);
  } catch (err) {
    process.stderr.write(`[review] could not write orchestrator-failure.log: ${(err as Error).message}\n`);
  }
}

/**
 * Shared tail: dedupe → (idempotent) post → summary. Used by both a fresh run
 * and `--resume`, so the dedupe/post/summary contract lives in exactly one place.
 * On `findingsUnavailable` (pipeline failure) it writes error.txt instead of the
 * summary, so `status` reports `failed` — never a clean review. Exported for tests.
 */
export async function finalizeReview(a: {
  prUrl: string;
  outDir: string;
  gather: GatherOutput;
  outputs: ReviewerOutput[];
  dedupeMode: 'strict' | 'loose' | 'off';
  publish: boolean;
  dryRun?: boolean;
  failOn?: Severity;
  /**
   * The orchestrator's primary contract failed (no parseable findings from the
   * session). True can coexist with non-empty `outputs` — the Codex sibling's
   * findings still dedupe and post — but the run is a pipeline failure (exit 2)
   * and must never mint the done-state summary.
   */
  findingsUnavailable: boolean;
  /** Re-read the PR's comments before deduping (set by --resume; a fresh run just gathered them). */
  refreshExisting?: boolean;
  forcePost?: boolean;
  overallStart: number;
  provider?: PrProvider;
  passRouting?: PassRoute[];
  /** Pack/baseline degradation notes — surfaced in the summary, not just stderr. */
  degraded?: string[];
}): Promise<ReviewResult> {
  for (const out of a.outputs) {
    try {
      writeFileSync(
        join(a.outDir, `raw-${sanitizeForFilename(out.reviewerName)}.json`),
        JSON.stringify(out.findings, null, 2),
        'utf8',
      );
    } catch (err) {
      process.stderr.write(`[review] could not write raw-${out.reviewerName}.json: ${(err as Error).message}\n`);
    }
  }

  const rawFindings = a.outputs.flatMap((o) => o.findings);
  const intraBatch = dedupeWithinBatch(rawFindings, a.dedupeMode);
  // Re-read the PR's comments before deduping. On a --resume the snapshot in
  // `gather` was taken BEFORE the original run tried to post, so anything that
  // run managed to publish is invisible to it — which is how an interrupted
  // run's resume posted a second copy of all 56 comments in the field.
  //
  // This lives here, next to the dedupe that depends on it, rather than in the
  // caller: an invariant installed one level up is one a future caller of
  // finalizeReview silently loses. Runs on --dry-run too — a dry-run reporting
  // 56 findings to post when the real run would post none is the same lie, one
  // step earlier.
  let existingComments = a.gather.existingComments;
  if (a.refreshExisting && a.dedupeMode !== 'off') {
    const { provider, ref } = resolvePr(a.prUrl, undefined, a.provider);
    try {
      const refreshed = await withRetry(
        () => provider.fetchExistingComments(ref),
        (e) => provider.isTransientError(e),
        'existing-comment refresh',
      );
      // UNION, scoped — never overwrite. Assigning the whole live list would
      // let any comment posted after the review started suppress a finding:
      // strict dedupe drops on 0.4 title similarity, so a few vague inline
      // comments on the changed lines ("double-check this auth path") would
      // silently bury the matching security findings. The only comments this
      // refresh needs are the ones an interrupted run of THIS tool wrote, and
      // those are byte-identical to a finding it was about to post.
      const ourBodies = new Set(a.outputs.flatMap((o) => o.findings).map((f) => f.body.trim()));
      const known = new Set(existingComments.map((c) => c.id));
      const ours = refreshed.filter((c) => !known.has(c.id) && ourBodies.has(c.body.trim()));
      existingComments = [...existingComments, ...ours];
      process.stderr.write(
        `[review] read ${refreshed.length} comment(s) from the PR; ${ours.length} match a finding this run would post
`,
      );
    } catch (err) {
      // Fail closed when publishing. Continuing would dedupe against a snapshot
      // known to predate a post attempt and re-post everything it published —
      // and nothing downstream catches it: runPost reconciles only on an error
      // path, and its window excludes comments written minutes ago. A dry-run
      // has nothing to duplicate.
      const why = `could not re-read the PR's comments (${(err as Error).message})`;
      if (a.publish && !a.forcePost) {
        throw new Error(
          `${why} — refusing to post, because deduping against the pre-post snapshot would duplicate whatever the interrupted run already published. Retry when the API is healthy, or pass --force-post if you have checked the PR by hand.`,
        );
      }
      process.stderr.write(`[review] ${why} — deduping against the gather snapshot
`);
    }
  }

  const dedupedAgainstExisting = dedupeAgainstExisting(intraBatch.kept, existingComments, a.dedupeMode);
  const finalFindings = dedupedAgainstExisting.kept;
  const droppedCount = intraBatch.dropped.length + dedupedAgainstExisting.dropped.length;
  if (droppedCount > 0) {
    process.stderr.write(
      `[review] dedupe dropped ${droppedCount} finding(s) (${intraBatch.dropped.length} intra-batch, ${dedupedAgainstExisting.dropped.length} vs existing comments)\n`,
    );
  }
  appendProgress(a.outDir, 'dedupe', `${finalFindings.length} kept, ${droppedCount} dropped`);

  let postResult: Awaited<ReturnType<typeof runPost>> | undefined;
  if (a.publish) {
    const marker = readPostedMarker(a.outDir);
    // Refuse re-posting when we KNOW the prior post fully succeeded, when the
    // marker is corrupt, or when the prior run could not verify its writes —
    // all three are "cannot rule out a completed post", so all three fail
    // closed. A partial *verified* post falls through so resume can recover
    // the un-posted rest.
    const known = marker !== null && marker !== 'corrupt' ? marker : null;
    const fullyPosted = known !== null && known.attempted > 0 && known.posted >= known.attempted;
    const unverified = known !== null && known.verified === false;
    if (!a.forcePost && (marker === 'corrupt' || fullyPosted || unverified)) {
      const why =
        marker === 'corrupt'
          ? 'posted.marker is unreadable — refusing to re-post to avoid duplicates'
          : unverified
            ? `the prior post could not be verified against the PR (${known!.posted}/${known!.attempted} counted) — refusing to re-post blind; check the PR, then use --force-post`
            : `this run already posted ${known!.posted} comment(s)`;
      process.stderr.write(`[review] ${why}; skipping post (use --force-post to override)\n`);
      appendProgress(a.outDir, 'post', 'skipped — already posted');
    } else {
      if (known && known.posted < known.attempted) {
        process.stderr.write(
          `[review] prior post was partial (${known.posted}/${known.attempted}) — re-posting the rest; findings already on the PR are skipped after the read-back\n`,
        );
      }
      process.stderr.write(`[review] posting comments…\n`);
      appendProgress(a.outDir, 'post', 'start');
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
      postResult = await runPost({ prUrl: a.prUrl, outputs: wrapper, publish: true, gather: a.gather, provider: a.provider });
      // Unconditional: a publish attempt happened, and that fact is the guard.
      // Gating this on `posted > 0` is what left the field incident's run with
      // no marker at all, so its --resume re-posted all 56 comments.
      writePostedMarker(a.outDir, {
        posted: postResult.posted,
        attempted: postResult.attempted,
        verified: postResult.verified,
      });
      appendProgress(a.outDir, 'post', `${postResult.posted} posted${postResult.verified ? '' : ' (unverified)'}`);
    }
  } else if (a.dryRun) {
    process.stderr.write(`[review] --dry-run: skipping post\n`);
  }

  let summary: string;
  if (a.findingsUnavailable) {
    // A failed pipeline must never mint the done-state artifacts: `status`
    // treats pr-review-summary.md as "done, exit 0" the moment it exists.
    summary =
      'pipeline failure: the orchestrator produced no parseable findings — this is NOT a clean PR.\n' +
      'Details: orchestrator-failure.log in this run dir.\n' +
      '--resume cannot recover this run (no loadable reviewer output); re-run the review.';
    try {
      writeFileSync(join(a.outDir, ERROR_FILE), summary + '\n', 'utf8');
    } catch (err) {
      // status degrades to the detached.log pointer — but say why on stderr
      process.stderr.write(`[review] could not write ${ERROR_FILE}: ${(err as Error).message}\n`);
    }
    appendProgress(a.outDir, 'error', 'orchestrator produced no parseable findings');
  } else {
    summary = renderSummary(a.prUrl, a.outputs, finalFindings, droppedCount, Date.now() - a.overallStart, postResult, a.passRouting, a.degraded);
    writeFileSync(join(a.outDir, 'pr-review-summary.md'), summary, 'utf8');
    writeFileSync(
      join(a.outDir, 'pr-review-findings.json'),
      JSON.stringify(
        {
          reviewers: a.outputs.map((o) => ({ reviewer: o.reviewerName, findings: o.findings })),
          finalFindings,
          droppedCount,
        },
        null,
        2,
      ),
      'utf8',
    );
    process.stderr.write(`[review] wrote summary to ${join(a.outDir, 'pr-review-summary.md')}\n`);
    appendProgress(a.outDir, 'done', `${postResult?.posted ?? 0} posted, ${finalFindings.length} findings`);
  }

  const exitCode = decideExitCode(a.findingsUnavailable, finalFindings, a.failOn);
  if (exitCode === 1) {
    process.stderr.write(`[review] --fail-on ${a.failOn}: findings at/above threshold\n`);
  }
  return { outputs: a.outputs, summary, exitCode };
}

/**
 * Resume a prior run from `~/.pr-review/runs/<id>/`: reuse its gather + reviewer
 * outputs already on disk and jump straight to dedupe/post. Turns a run killed
 * after the (expensive) reviewer phase into a ~1-minute finish.
 */
async function resumeReview(opts: ReviewCmdOptions): Promise<ReviewResult> {
  const overallStart = Date.now();
  const runId = opts.resumeRunId!;
  const outDir = opts.runDir ?? join(RUNS_ROOT, runId);
  if (!existsSync(outDir)) throw new Error(`resume: run dir not found: ${outDir}`);
  const gatherPath = join(outDir, 'pr-review-gather.json');
  if (!existsSync(gatherPath)) {
    throw new Error(`resume: run ${runId} has no pr-review-gather.json — cannot resume`);
  }
  const gather = JSON.parse(readFileSync(gatherPath, 'utf8')) as GatherOutput;

  let outputs: ReviewerOutput[] | null = null;
  for (const f of REVIEWER_OUTPUT_FILES) {
    const p = join(outDir, f);
    if (!existsSync(p)) continue;
    try {
      outputs = parseFindingsFile(p, '(resumed)', 0);
      process.stderr.write(`[review] resume: loaded reviewer outputs from ${f}\n`);
      break;
    } catch (err) {
      process.stderr.write(`[review] resume: ${f} unreadable (${(err as Error).message})\n`);
    }
  }
  if (!outputs) {
    throw new Error(
      `resume: run ${runId} has no reviewer output (single-session-findings.json / phase1-findings.json) — nothing to resume`,
    );
  }

  process.stderr.write(`[review] resuming run ${runId} from ${outDir}\n`);
  appendProgress(outDir, 'resume', `run ${runId}`);
  const { config } = loadConfig({ cwd: process.cwd(), homeOverride: opts.homeOverride, cliOverrides: toConfigOverrides(opts) });
  // The live run persisted routing here; absent (old / pre-0.7 runs) → Skills section omitted.
  let passRouting: PassRoute[] | undefined;
  const routingPath = join(outDir, 'passes.json');
  if (existsSync(routingPath)) {
    try {
      // Validate the shape, not just the syntax: JSON that parses to a non-array
      // ({}, null, "x") would otherwise reach summarizePasses and throw there —
      // i.e. AFTER posting — losing the summary on an otherwise successful resume.
      const parsed: unknown = JSON.parse(readFileSync(routingPath, 'utf8'));
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r.name === 'string' && typeof r.matchedBy === 'string')) {
        passRouting = parsed as PassRoute[];
      } else {
        process.stderr.write(`[review] resume: passes.json has an unexpected shape — Skills section omitted\n`);
      }
    } catch (err) {
      // An absent file is expected (old runs); one that exists but fails to load is not.
      process.stderr.write(`[review] resume: passes.json unreadable (${(err as Error).message}) — Skills section omitted\n`);
    }
  }
  return finalizeReview({
    prUrl: opts.prUrl,
    outDir,
    gather,
    outputs,
    // The gather snapshot predates the interrupted run's post attempt, so the
    // comments it managed to publish are invisible to dedupe. finalizeReview
    // owns the refresh because it owns the dedupe that depends on it.
    refreshExisting: true,
    dedupeMode: config.dedupeMode,
    publish: !!opts.publish,
    dryRun: opts.dryRun,
    failOn: opts.failOn,
    findingsUnavailable: false,
    forcePost: opts.forcePost,
    overallStart,
    provider: opts.provider,
    passRouting,
  });
}

export async function runReview(opts: ReviewCmdOptions): Promise<ReviewResult> {
  if (opts.resumeRunId) return resumeReview(opts);

  const overallStart = Date.now();
  const cwd = process.cwd();
  const { provider, ref } = resolvePr(opts.prUrl, undefined, opts.provider);
  const outDir = opts.runDir ?? ensureRunDir(ref);
  if (opts.runDir) mkdirSync(opts.runDir, { recursive: true });
  process.stderr.write(`[review] run artifacts → ${outDir}\n`);
  // Liveness beacon: `status` checks this pid to tell a slow-but-healthy run
  // from a dead one, so an intermediate artifact never reads as "interrupted".
  try {
    writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
  } catch {
    // best-effort — status falls back to artifact heuristics without it
  }

  const { config } = loadConfig({ cwd, homeOverride: opts.homeOverride, cliOverrides: toConfigOverrides(opts) });

  if (opts.fromGather && !opts.dryRun) {
    throw new Error('--from-gather requires --dry-run (offline eval hook; posting from a fabricated gather is not allowed)');
  }

  // CLI --skip replaces the config list for the run (same rule the session uses).
  const effectiveSkip = opts.skip?.length ? opts.skip : config.skipReviewers;

  // Packs + Linguist resolve alongside gather/companion detection. Review-time is
  // clone-if-missing ONLY (`packs sync` is the explicit update path); every
  // failure is a warning — a review runs with whatever is on disk.
  const packsPromise = Promise.resolve().then(() => ensurePacks(config.skillPacks, { home: opts.homeOverride }));
  // No packs configured → language tags feed nothing glob/tag-matched; skip the
  // (possibly network) Linguist load entirely.
  const linguistPromise =
    config.skillPacks.length > 0 ? loadLinguist({ home: opts.homeOverride }) : Promise.resolve(null);

  let runtime: Runtime;
  try {
    runtime = resolveRuntime(config.runtime, opts.copilotBinary);
  } catch (err) {
    if (!opts.contextOnly) throw err;
    // --context-only never spawns the runtime; a machine with neither CLI can
    // still preview the context and skill routing.
    runtime = 'copilot';
    process.stderr.write(`[review] ${(err as Error).message} — continuing with --context-only using copilot prompt vocabulary\n`);
  }
  process.stderr.write(`[review] runtime: ${runtime}\n`);

  const wantCodex = config.invokeCodex && !effectiveSkip.includes('codex');
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

  const gather = opts.fromGather
    ? (JSON.parse(readFileSync(opts.fromGather, 'utf8')) as GatherOutput)
    : await runGather({
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
    appendProgress(outDir, 'done', 'early exit');
    return { outputs: [], summary, exitCode: 0 };
  }
  appendProgress(outDir, 'gather', `${gather.changedFiles.filter((f) => !f.excluded).length} files`);

  const [packsResult, linguist] = await Promise.all([
    packsPromise,
    linguistPromise,
    companionPromise,
    codexDetectPromise,
  ]);
  for (const name of packsResult.cloned) {
    process.stderr.write(`[packs] cloned ${name} (first use) — refresh later with \`pr-review packs sync\`\n`);
  }
  for (const w of packsResult.warnings) process.stderr.write(w + '\n');
  const includeCodex = wantCodex && codexAvailable;
  if (wantCodex && !codexAvailable) {
    process.stderr.write(`[codex] codex CLI not found on PATH — skipping the second-opinion reviewer\n`);
  }

  // Every review pass is a skill: user-authored reviewer .md files are never loaded.
  const loaded = loadAll({ cwd, config, skillsOnly: true, home: opts.homeOverride });
  process.stderr.write(
    `[review] discovered ${loaded.skills.length + loaded.catalog.length} project skill(s) + ${loaded.packSkills.length} pack skill(s)\n`,
  );

  const inScopeFiles = gather.changedFiles.filter((f) => !f.excluded);
  const stack = detectStack(inScopeFiles, { linguist, cwd, pr: ref });
  for (const n of stack.notes) process.stderr.write(`[stack] ${n}\n`);

  // The checkout's skills carry authority ONLY when the checkout IS the PR's
  // repo — reviewing repo A from inside repo B must not inject B's rules.
  // Explicitly forced dirs (--skills-dir / extra_skills_dirs) always apply.
  const projectEligible = stack.cwdIsPrRepo;
  const skillsForSelection = projectEligible ? loaded.skills : loaded.skills.filter((s) => s.origin === 'forced');
  const catalogForSelection = projectEligible ? loaded.catalog : [];
  if (!projectEligible && (loaded.skills.some((s) => s.origin !== 'forced') || loaded.catalog.length > 0)) {
    process.stderr.write(
      `[skills] cwd is not the PR's repo — its skills are not used as project rules (forced dirs still apply)\n`,
    );
  }

  const selection = (opts.selectPassesFn ?? selectPasses)({
    skills: skillsForSelection,
    catalog: catalogForSelection,
    packSkills: loaded.packSkills,
    inScopeFiles,
    stackTags: stack.tags,
    baseline: config.skillPacks.flatMap((p) => p.baseline.map((b) => `${p.name}/${b}`)),
  });
  for (const b of selection.missingBaseline) {
    process.stderr.write(
      `[packs] WARNING: baseline skill '${b}' not found after sync — renamed upstream? Run \`pr-review packs sync\` or fix skill_packs[].baseline\n`,
    );
  }
  // Degradation must reach the summary, not only stderr — a detached run's
  // reader never sees detached.log unless told to look.
  const degraded = [
    ...packsResult.warnings,
    ...selection.missingBaseline.map((b) => `baseline skill '${b}' not found — renamed upstream?`),
  ];

  const sessionOpts = {
    prUrl: opts.prUrl,
    gather,
    passes: selection.passes,
    projectSkills: selection.projectSkills,
    indexEntries: selection.indexEntries,
    stackTags: selection.stackTags,
    installedCompanions,
    skipReviewers: effectiveSkip,
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
      `**Passes to dispatch:** ${ctx.passes.map((p) => p.name).join(', ') || '(none)'}${includeCodex ? ' + codex (sibling process)' : ''}`,
    ];
    if (ctx.triageSkipped.length > 0) {
      lines.push(`**Skipped by triage (docs-only PR):** ${ctx.triageSkipped.join(', ')}`);
    }
    lines.push(``, `## Stack`, ``);
    lines.push(`- **Languages:** ${stack.languages.join(', ') || '(none)'}`);
    lines.push(
      `- **Dependencies:** ${stack.dependencies.slice(0, 30).join(', ') || '(none)'}${stack.dependencies.length > 30 ? ` (+${stack.dependencies.length - 30} more)` : ''}`,
    );
    for (const n of stack.notes) lines.push(`- _${n}_`);
    lines.push(``, `## Passes`, ``);
    if (ctx.passes.length === 0) {
      lines.push('_No passes — no skill matched this PR and no baseline is configured._');
    } else {
      lines.push(`| Pass | Matched by | Matched on | Source |`, `|---|---|---|---|`);
      for (const p of ctx.passes) {
        lines.push(`| ${p.name} | ${p.matchedBy} | ${p.matchedOn.join(', ') || '—'} | ${p.source} |`);
      }
    }
    const projectRows = ctx.routing.filter((r) => r.matchedBy === 'context');
    if (projectRows.length > 0) {
      lines.push(
        ``,
        `**Project rules (injected into every pass):** ${projectRows.map((r) => r.name).join(', ')} → \`${join(outDir, 'skills-project.md')}\``,
      );
    }
    const idxCount = ctx.routing.filter((r) => r.matchedBy === 'index').length;
    if (idxCount > 0) lines.push(``, `**Index (on-demand):** ${idxCount} skill(s) → \`${join(outDir, 'skills-index.md')}\``);
    const summary = lines.join('\n');
    // Zero passes on a code PR is the "nothing to review with" failure (exit 2):
    // status treats pr-review-summary.md as done/exit-0 the moment it exists, so
    // the failed preview writes error.txt instead of the done-state artifact.
    const zeroPasses = ctx.passes.length === 0 && ctx.triageSkipped.length === 0;
    writeFileSync(join(outDir, zeroPasses ? ERROR_FILE : 'pr-review-summary.md'), summary, 'utf8');
    return { outputs: [], summary, exitCode: zeroPasses ? 2 : 0 };
  }

  // Context is prepared exactly once and shared by the session and the codex
  // sibling — a second prepare would rewrite every context/skills file.
  const sessionCtx = prepareSessionContext(sessionOpts);

  if (sessionCtx.passes.length === 0) {
    if (sessionCtx.triageSkipped.length > 0) {
      // Docs-only PR and nothing doc-scoped to run — benign, not a failure.
      const line = `docs-only PR with no doc-scoped review skill — nothing to review (skipped passes: ${sessionCtx.triageSkipped.join(', ')})`;
      process.stderr.write(`[review] ${line}\n`);
      const summary = [`# PR Review Summary`, ``, `**PR:** ${opts.prUrl}`, ``, line].join('\n');
      writeFileSync(join(outDir, 'pr-review-summary.md'), summary, 'utf8');
      appendProgress(outDir, 'done', 'docs-only, no passes');
      return { outputs: [], summary, exitCode: 0 };
    }
    // Never a silent 0: an empty review is not a clean PR.
    const line = `nothing to review with — no skills matched this PR (stack tags: ${selection.stackTags.join(', ') || 'none'}); run \`pr-review packs suggest ${opts.prUrl}\` or configure skill_packs`;
    process.stderr.write(`[review] ${line}\n`);
    try {
      writeFileSync(join(outDir, ERROR_FILE), line + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`[review] could not write ${ERROR_FILE}: ${(err as Error).message}\n`);
    }
    appendProgress(outDir, 'error', 'no review passes');
    return { outputs: [], summary: line, exitCode: 2 };
  }

  process.stderr.write(
    `[review] single-session dispatch: ${sessionCtx.passes.length} pass(es) + verifier + ` +
      `${config.invokeCompanions ? `${installedCompanions.length} companion(s)` : '0 companions'}` +
      `${includeCodex ? ' + codex' : ''}\n`,
  );

  // Heads-up at the start: print the Skills section (foreground console + detached.log)
  // and fold a compact count into the dispatch progress event (the live `status` snapshot).
  const skills = summarizePasses(sessionCtx.routing);
  process.stderr.write(skills.section.join('\n') + '\n');
  appendProgress(outDir, 'dispatch', skills.brief);

  // Codex runs as a sibling process, in parallel with the orchestrator session.
  // runCodexReviewer resolves on every failure path with `error` set — spawn
  // rejection included, since it catches spawnCli's synchronous argv validation
  // (win32 only) inside its own promise executor. Handling it there rather than
  // here is what routes the failure through codex-failure.log instead of
  // leaving one stderr line behind.
  let codexPromise: Promise<ReviewerOutput> | null = null;
  if (includeCodex) {
    codexPromise = runCodexReviewer({
      contextPath: sessionCtx.contextPath,
      skillsPath: sessionCtx.skillsFiles['project'] ?? sessionCtx.skillsFiles['all'],
      outDir,
    });
  }

  const session = await runSingleSession(sessionOpts, sessionCtx);

  const outputs = session.outputs;
  if (codexPromise) {
    const codexOut = await codexPromise;
    outputs.push(codexOut);
  }
  appendProgress(outDir, 'dispatch', `done — ${outputs.reduce((n, o) => n + o.findings.length, 0)} raw findings`);

  const result = await finalizeReview({
    prUrl: opts.prUrl,
    outDir,
    gather,
    outputs,
    dedupeMode: config.dedupeMode,
    publish: !!opts.publish,
    dryRun: opts.dryRun,
    failOn: opts.failOn,
    findingsUnavailable: session.findingsUnavailable,
    forcePost: opts.forcePost,
    degraded,
    overallStart,
    provider,
    passRouting: sessionCtx.routing,
  });

  if (result.exitCode === 2) {
    const codexNote = outputs.some((o) => o.reviewerName === 'codex' && o.findings.length > 0)
      ? ' Codex second-opinion findings were still collected/posted, but a lone sibling pass is not a complete review.'
      : '';
    process.stderr.write(
      `[review] pipeline failure: the orchestrator produced no parseable findings (this is NOT a clean PR).${codexNote}\n`,
    );
    writeOrchestratorFailureLog(outDir, session.exitCode, session.rawOrchestratorOutput, session.rawOrchestratorStderr);
  }
  return result;
}
