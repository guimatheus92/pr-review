import { resolvePr } from '../providers/index.js';
import { buildValidLinesMap, snapLineToDiff } from '../dispatch/line-snap.js';
import { RETRY_BACKOFF_MS } from '../util/retry.js';
import type { ChangedFile, Finding, GatherOutput, PrRef, ReviewerOutput } from '../types.js';
import type { BatchComment, PrProvider } from '../providers/types.js';

interface PostOptions {
  prUrl: string;
  outputs: ReviewerOutput[];
  publish: boolean;
  /** When provided, enables line snapping (via changedFiles patches) and skips the head-SHA fetch. */
  gather?: GatherOutput;
  /** Test seam — defaults to detectProvider(prUrl). */
  provider?: PrProvider;
}

export interface PostResult {
  attempted: number;
  posted: number;
  skipped: number;
  errors: { finding: Finding; error: string }[];
}

/**
 * Clock slack on the "created during this run" filter. Comment timestamps come
 * from the provider's clock, not ours, and GitHub truncates them to the second
 * — without slack our own just-written comment can read as older than the post
 * and go uncounted, which is the exact miscount this whole path exists to
 * prevent. Erring loose is the safe direction here: `dedupeAgainstExisting`
 * already dropped findings matching comments that were on the PR beforehand,
 * so a body still in the post list is not supposed to be there yet.
 */
const CLOCK_SLACK_MS = 60_000;

/**
 * How many comments carrying each body are on the PR right now, counting only
 * those created during this run. A multiset, not a Set: two findings could in
 * principle carry the same body, and each needs its own comment.
 *
 * Never throws. A read problem must not turn into a post failure, so a failed
 * read answers "nothing landed" — the conservative direction, since it makes
 * the caller retry or fall back rather than assume success.
 */
async function landedBodies(provider: PrProvider, ref: PrRef, since: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const existing = await provider.fetchExistingComments(ref);
    for (const c of existing) {
      const at = Date.parse(c.createdAt);
      // An unparseable timestamp counts: a provider that omits createdAt must
      // not silently blind the verification.
      if (Number.isFinite(at) && at < since - CLOCK_SLACK_MS) continue;
      const key = c.body.trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  } catch (err) {
    process.stderr.write(
      `[post] could not read the PR back to verify (${(err as Error).message}) — assuming nothing landed\n`,
    );
  }
  return counts;
}

/** Claim one comment carrying `key`, so N identical bodies need N comments. */
function claim(counts: Map<string, number>, key: string): boolean {
  const n = counts.get(key) ?? 0;
  if (n <= 0) return false;
  counts.set(key, n - 1);
  return true;
}

/**
 * Post every inline finding as one review, verifying against the PR before
 * ever retrying or falling back.
 *
 * A 5xx or timeout on the create-review call means "unknown", NOT "nothing
 * written": the server can commit the review and lose the response on the way
 * back. Retrying blind then trips the secondary rate limit — precisely because
 * the write already happened — so the batch reads as failed and the
 * per-comment fallback re-posts everything. In the field that turned 56
 * findings into 112 comments while the run reported `posted 0 / errors 56`.
 *
 * So: attempt, and on any error read the PR back and let the server say what
 * still needs posting. Reconciling first is what makes a retry safe.
 */
async function postBatchReconciling(
  provider: PrProvider,
  ref: PrRef,
  headSha: string,
  inline: Finding[],
  since: number,
): Promise<{ posted: number; missing: Finding[] }> {
  let posted = 0;
  let pending = inline;

  for (let attempt = 0; ; attempt++) {
    const comments: BatchComment[] = pending.map((f) => ({ path: f.file!, line: f.line!, body: f.body.trim() }));
    try {
      const batch = await provider.postBatchComments!(ref, headSha, comments);
      posted += batch.posted;
      process.stderr.write(`[post] posted ${batch.posted} inline comment(s) as one review\n`);
      return { posted, missing: [] };
    } catch (err) {
      const landed = await landedBodies(provider, ref, since);
      const missing = pending.filter((f) => !claim(landed, f.body.trim()));
      const gained = pending.length - missing.length;
      posted += gained;

      if (missing.length === 0) {
        process.stderr.write(
          `[post] the batch call failed but all ${gained} comment(s) are on the PR — the write landed and the response was lost; not re-posting\n`,
        );
        return { posted, missing: [] };
      }
      if (gained > 0) {
        process.stderr.write(`[post] batch partially landed: ${gained} on the PR, ${missing.length} still missing\n`);
      }
      pending = missing;

      const retriable = attempt < RETRY_BACKOFF_MS.length && (provider.isTransientError?.(err as Error) ?? false);
      if (!retriable) {
        // Log the FULL error: when the cause is systemic (auth scope, closed
        // PR) the per-comment failures that follow would bury the root cause.
        process.stderr.write(
          `[post] batch review failed; falling back to per-comment posting for ${pending.length} finding(s). Cause:\n${(err as Error).message}\n`,
        );
        return { posted, missing: pending };
      }
      const delay = RETRY_BACKOFF_MS[attempt]!;
      process.stderr.write(
        `[retry] transient error on review batch (${pending.length} comments) — retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${delay}ms: ${(err as Error).message.split('\n')[0]}\n`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Snap located findings to the nearest valid diff line. When reanchor is set
 * (GitHub: review comments only attach to diff lines, and no finding may be
 * dropped), findings that cannot anchor where the reviewer pointed — file
 * outside the diff, or no location at all — are re-anchored to the first
 * valid line of the first changed file, with the original location kept in
 * the body. Without a valid anchor a bad path would 422 the whole batch.
 */
export function snapFindingsToDiff(
  findings: Finding[],
  changedFiles: ChangedFile[],
  reanchor: boolean,
): { findings: Finding[]; snapped: number; reanchored: number; anchor: { file: string; line: number } | null } {
  const validLines = buildValidLinesMap(changedFiles);
  let anchor: { file: string; line: number } | null = null;
  if (reanchor) {
    for (const [file, lines] of validLines) {
      if (lines.size > 0) {
        anchor = { file, line: Math.min(...lines) };
        break;
      }
    }
  }
  const out: Finding[] = [];
  let snapped = 0;
  let reanchored = 0;
  for (const f of findings) {
    const snappedLine = f.file && f.line ? snapLineToDiff(validLines, f.file, f.line) : null;
    if (snappedLine !== null) {
      if (snappedLine !== f.line) {
        snapped++;
        out.push({ ...f, line: snappedLine });
      } else {
        out.push(f);
      }
      continue;
    }
    if (!anchor) {
      out.push(f);
      continue;
    }
    reanchored++;
    const body = f.file && f.line ? `\`${f.file}:${f.line}\` — ${f.body}` : f.body;
    out.push({ ...f, file: anchor.file, line: anchor.line, body });
  }
  return { findings: out, snapped, reanchored, anchor };
}

export async function runPost(opts: PostOptions): Promise<PostResult> {
  const { provider, ref } = resolvePr(opts.prUrl, undefined, opts.provider);

  const allFindings: Finding[] = opts.outputs.flatMap((o) => o.findings);
  const result: PostResult = { attempted: 0, posted: 0, skipped: 0, errors: [] };

  if (!opts.publish) {
    result.skipped = allFindings.length;
    process.stderr.write(`[post] dry-run: would have posted ${allFindings.length} comment(s)\n`);
    return result;
  }

  // Snap reviewer-supplied lines to the nearest valid diff line so inline
  // comments do not 422 the batch review. On GitHub and GitLab, findings that
  // cannot anchor where they point are re-anchored instead of dropped — every
  // finding must land as a resolvable inline review thread.
  let findings = allFindings;
  if (opts.gather) {
    const reanchor = provider.name === 'github' || provider.name === 'gitlab';
    const snap = snapFindingsToDiff(allFindings, opts.gather.changedFiles, reanchor);
    findings = snap.findings;
    if (snap.snapped > 0) process.stderr.write(`[post] snapped ${snap.snapped} finding line(s) to the diff\n`);
    if (snap.reanchored > 0) {
      process.stderr.write(
        `[post] re-anchored ${snap.reanchored} finding(s) without a diff location to ${snap.anchor!.file}:${snap.anchor!.line}\n`,
      );
    }
  }

  const headSha = opts.gather?.metadata.headSha ?? (await provider.fetchMetadata(ref)).headSha;

  // Every finding is attempted exactly once, whether it rides the batch or the
  // per-comment loop — so the count is the input size, not a running tally that
  // a partially-landed batch could double.
  result.attempted = findings.length;
  const postStartedAt = Date.now();

  // Batch path: one review with all inline comments (single write, immune to
  // the per-comment burst quota). On failure the PR is read back, and only the
  // findings that genuinely are not there fall through to per-comment posting.
  let remaining = findings;
  if (provider.postBatchComments) {
    const inline = findings.filter((f) => f.file && f.line);
    if (inline.length > 0) {
      const batch = await postBatchReconciling(provider, ref, headSha, inline, postStartedAt);
      result.posted += batch.posted;
      remaining = findings.filter((f) => !(f.file && f.line)).concat(batch.missing);
    }
  }

  for (const f of remaining) {
    try {
      const out = await provider.postLineComment(ref, f, headSha);
      if (out) {
        result.posted++;
      } else {
        // `skipped` exists only for --dry-run: a finding the provider cannot
        // place inline on a publish run is an error, never silently dropped.
        result.errors.push({ finding: f, error: 'no diff-anchored location; could not post as an inline comment' });
      }
    } catch (err) {
      result.errors.push({ finding: f, error: (err as Error).message });
    }
  }

  // Report what the PR actually has, not what the write calls returned. This
  // number decides whether the user reaches for --resume, so a false negative
  // here is what duplicates a whole review.
  //
  // Deliberately one-way: errors may be promoted to posted, never the reverse.
  // Demoting on a stale read would mark a live comment un-posted and send the
  // next resume out to write it again — the very bug being fixed.
  if (result.errors.length > 0) {
    const landed = await landedBodies(provider, ref, postStartedAt);
    const recovered = new Set(result.errors.filter((e) => claim(landed, e.finding.body.trim())));
    if (recovered.size > 0) {
      result.posted += recovered.size;
      result.errors = result.errors.filter((e) => !recovered.has(e));
      process.stderr.write(
        `[post] ${recovered.size} finding(s) reported an error but are on the PR — counting them as posted (a lost response, not a failed write)\n`,
      );
    }
  }

  process.stderr.write(
    `[post] posted ${result.posted} / attempted ${result.attempted}; skipped ${result.skipped}; errors ${result.errors.length}\n`,
  );
  return result;
}
