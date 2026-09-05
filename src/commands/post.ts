import { resolvePr } from '../providers/index.js';
import { buildValidLinesMap, snapLineToDiff } from '../dispatch/line-snap.js';
import { RETRY_BACKOFF_MS, withRetry } from '../util/retry.js';
import type { ChangedFile, ExistingComment, Finding, GatherOutput, PrRef, ReviewerOutput } from '../types.js';
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
  /**
   * False when at least one write's outcome could not be checked against the
   * PR (the read-back failed). `finalizeReview` records this in `posted.marker`
   * so a later `--resume` fails closed instead of guessing — an unverified run
   * is the one case where both "post again" and "skip" can be wrong.
   */
  verified: boolean;
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

// ---------------------------------------------------------------------------
// Reconciliation — the PR is the only source of truth about a write
// ---------------------------------------------------------------------------

/**
 * Slack on the "created during this run" window, in both directions. Comment
 * timestamps come from the provider's clock and GitHub truncates them to the
 * second, so a comment written moments ago can read as fractionally older than
 * the post began.
 *
 * The window only has to be roughly right, because the multiset is keyed on
 * `file:line:body` (see `commentKey`) — a stale comment can only be mistaken
 * for ours if it sits at the same location AND carries the same text, which
 * `dedupeWithinBatch` folds. Erring loose therefore costs little, while erring
 * tight re-posts comments that are already live.
 */
export const CLOCK_SLACK_MS = 60_000;

/** Head/tail budget for the excluded-by-window warning; purely cosmetic. */
const SKEW_WARN_LIMIT = 5;

/**
 * Identity of a comment for reconciliation: location AND text.
 *
 * Body alone is not identity. Two findings can legitimately carry the same
 * body — `dedupeWithinBatch` only folds duplicates in the same file within 3
 * lines, deliberately keeping one rule flagged at several real sites — so a
 * body-only key lets one comment satisfy a different finding. That promotes a
 * finding that was never posted from `errors` to `posted`; if it brings
 * `posted` up to `attempted`, `finalizeReview` writes a *complete*
 * `posted.marker` and the next `--resume` refuses to post it. Silent loss with
 * the recovery path locked shut — strictly worse than the duplicate this
 * module was written to prevent.
 *
 * Caveat: GitHub reports `line: null` on comments outdated by a push and
 * `fetchExistingComments` falls back to `original_line`, so the key is stable
 * within a post window but would not survive a mid-run force-push.
 */
export function commentKey(file: string | undefined, line: number | undefined, body: string): string {
  return `${file ?? ''}\0${line ?? ''}\0${body.trim()}`;
}

function findingKey(f: Finding): string {
  return commentKey(f.file, f.line, f.body);
}

/** Claim one comment carrying `key`, so N identical findings need N comments. */
function claim(counts: Map<string, number>, key: string): boolean {
  const n = counts.get(key) ?? 0;
  if (n <= 0) return false;
  counts.set(key, n - 1);
  return true;
}

/**
 * Where the "created during this run" window starts, anchored to the
 * provider's clock rather than ours.
 *
 * `Date.now()` on the posting machine compared against provider timestamps is
 * a one-sided hazard: a local clock running more than the slack ahead makes
 * every comment this run just wrote read as old, the read comes back empty,
 * and the whole batch is written a second time — a duplicated review caused by
 * a clock nobody would think to check. The newest `createdAt` already on the
 * PR is a floor expressed in the provider's own time, so drift cancels out.
 * With no existing comments there is nothing to anchor to and local time is
 * the only option left.
 */
export function windowStart(existing: ExistingComment[] | undefined, fallback: number): number {
  let newest = 0;
  for (const c of existing ?? []) {
    const at = Date.parse(c.createdAt);
    if (Number.isFinite(at) && at > newest) newest = at;
  }
  return newest > 0 ? newest : fallback;
}

/**
 * What the PR actually holds right now, as a multiset of `commentKey`s,
 * counting only comments created during this run.
 *
 * Returns **null** when the PR could not be read. That is not the same as an
 * empty map and callers must not treat it as one: after a non-idempotent write
 * a failed read leaves the outcome *unknown*, and resolving unknown to
 * "nothing landed" is the exact inference this module exists to remove. The
 * two failures are correlated, too — the outage that 504s a write is what also
 * fails the read-back — so this is the reachable case, not the exotic one.
 *
 * The read is idempotent, so unlike the write it is safe to retry.
 */
async function readLanded(
  provider: PrProvider,
  ref: PrRef,
  since: number,
  pendingKeys: Set<string>,
): Promise<Map<string, number> | null> {
  const floor = since - CLOCK_SLACK_MS;
  let existing: ExistingComment[];
  try {
    existing = await withRetry(
      () => provider.fetchExistingComments(ref, new Date(floor)),
      (e) => provider.isTransientError(e),
      'PR read-back',
    );
  } catch (err) {
    process.stderr.write(
      `[post] could not read the PR back to verify (${(err as Error).message}) — outcome UNKNOWN, not empty\n`,
    );
    return null;
  }

  const counts = new Map<string, number>();
  let inWindow = 0;
  const skewSuspects: string[] = [];
  for (const c of existing) {
    // This tool never posts a top-level comment (AGENTS.md, inline-only), so a
    // comment with no file cannot be ours and must never stand in as proof of
    // our own write.
    if (!c.file) continue;
    const key = commentKey(c.file, c.line, c.body);
    const at = Date.parse(c.createdAt);
    if (Number.isFinite(at) && at < floor) {
      // An excluded comment that matches something we are about to post is the
      // one case worth reporting: either a prior run left it, or our clock is
      // wrong. Silently dropping it is how a duplicate gets explained away.
      if (pendingKeys.has(key) && skewSuspects.length < SKEW_WARN_LIMIT) skewSuspects.push(`${c.file}:${c.line}`);
      continue;
    }
    inWindow++;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  process.stderr.write(`[post] read ${existing.length} comment(s); ${inWindow} created during this run\n`);
  if (skewSuspects.length > 0) {
    process.stderr.write(
      `[post] ${skewSuspects.length} comment(s) match a pending finding but fall outside the created-at window (${skewSuspects.join(', ')}) — clock skew, or a prior run\n`,
    );
  }
  return counts;
}

interface BatchOutcome {
  posted: number;
  /** Confirmed absent from the PR — safe to write one at a time. */
  missing: Finding[];
  /** Outcome unknown (the read-back failed) — must NOT be written again. */
  unverified: Finding[];
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
 * still needs posting. Reconciling first is what makes a retry safe — and when
 * the read itself fails there is no safe retry, only a report.
 */
async function postBatchReconciling(
  provider: PrProvider,
  ref: PrRef,
  headSha: string,
  inline: Finding[],
  since: number,
): Promise<BatchOutcome> {
  let posted = 0;
  let pending = inline;

  for (let attempt = 0; ; attempt++) {
    const comments: BatchComment[] = pending.map((f) => ({ path: f.file!, line: f.line!, body: f.body.trim() }));
    try {
      const batch = await provider.postBatchComments!(ref, headSha, comments);
      // The interface requires a throw on any shortfall. Trusting a partial
      // count would strand the difference in neither `posted` nor `missing`,
      // quietly breaking `posted + errors === attempted`.
      if (batch.posted < comments.length) {
        throw new Error(
          `provider returned a partial batch (${batch.posted}/${comments.length}); postBatchComments must throw on any shortfall`,
        );
      }
      posted += comments.length;
      process.stderr.write(`[post] posted ${comments.length} inline comment(s) as one review\n`);
      return { posted, missing: [], unverified: [] };
    } catch (err) {
      const landed = await readLanded(provider, ref, since, new Set(pending.map(findingKey)));
      if (landed === null) {
        process.stderr.write(
          `[post] batch failed AND the PR could not be read back — refusing to re-issue ${pending.length} finding(s); re-run with --resume once the API is healthy\n`,
        );
        return { posted, missing: [], unverified: pending };
      }

      const missing = pending.filter((f) => !claim(landed, findingKey(f)));
      const gained = pending.length - missing.length;
      posted += gained;

      if (missing.length === 0) {
        process.stderr.write(
          `[post] the batch call failed but all ${gained} comment(s) are on the PR — the write landed and the response was lost; not re-posting\n`,
        );
        return { posted, missing: [], unverified: [] };
      }
      if (gained > 0) {
        process.stderr.write(`[post] batch partially landed: ${gained} on the PR, ${missing.length} still missing\n`);
      }
      pending = missing;

      if (attempt >= RETRY_BACKOFF_MS.length || !provider.isTransientError(err as Error)) {
        // Log the FULL error: when the cause is systemic (auth scope, closed
        // PR) the per-comment failures that follow would bury the root cause.
        process.stderr.write(
          `[post] batch review failed; falling back to per-comment posting for ${pending.length} finding(s). Cause:\n${(err as Error).message}\n`,
        );
        return { posted, missing: pending, unverified: [] };
      }
      const delay = RETRY_BACKOFF_MS[attempt]!;
      process.stderr.write(
        `[retry] transient error on review batch (${pending.length} comments) — retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${delay}ms: ${(err as Error).message.split('\n')[0]}\n`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
}

interface EachOutcome {
  posted: Finding[];
  errors: { finding: Finding; error: string }[];
  unverified: Finding[];
}

/**
 * Post the leftovers one at a time, under the same rule as the batch: the
 * provider makes ONE attempt and throws, and a failure is only re-issued after
 * the PR confirms the comment is genuinely not there.
 *
 * The providers used to own this retry (`withRetry` around `createReviewComment`
 * / `createThread` / `POST /discussions`), which is the same blind retry on a
 * non-idempotent write that was removed from the batch path — and it ran in
 * the path reached *because* the batch already failed, i.e. exactly when lost
 * responses happen. Retries are batched by pass so one read-back covers the
 * whole round rather than one per comment.
 */
async function postEachReconciling(
  provider: PrProvider,
  ref: PrRef,
  findings: Finding[],
  headSha: string,
  since: number,
): Promise<EachOutcome> {
  const posted: Finding[] = [];
  const unverified: Finding[] = [];
  const failures = new Map<Finding, Error>();
  const unplaceable = new Map<Finding, string>();
  let pending = findings;

  for (let attempt = 0; pending.length > 0; attempt++) {
    const failed: Finding[] = [];
    for (const f of pending) {
      try {
        const out = await provider.postLineComment(ref, f, headSha);
        failures.delete(f);
        if (out) {
          posted.push(f);
        } else {
          // `skipped` exists only for --dry-run: a finding the provider cannot
          // place inline on a publish run is an error, never silently dropped.
          unplaceable.set(f, 'no diff-anchored location; could not post as an inline comment');
        }
      } catch (err) {
        failures.set(f, err as Error);
        failed.push(f);
      }
    }

    const retriable = failed.filter((f) => provider.isTransientError(failures.get(f)!));
    if (retriable.length === 0 || attempt >= RETRY_BACKOFF_MS.length) break;

    const landed = await readLanded(provider, ref, since, new Set(retriable.map(findingKey)));
    if (landed === null) {
      process.stderr.write(
        `[post] a comment failed AND the PR could not be read back — refusing to re-issue ${retriable.length} finding(s)\n`,
      );
      unverified.push(...retriable);
      for (const f of retriable) failures.delete(f);
      break;
    }

    const stillMissing: Finding[] = [];
    for (const f of retriable) {
      if (claim(landed, findingKey(f))) {
        posted.push(f);
        failures.delete(f);
      } else {
        stillMissing.push(f);
      }
    }
    if (stillMissing.length === 0) break;

    const delay = RETRY_BACKOFF_MS[attempt]!;
    process.stderr.write(
      `[retry] ${stillMissing.length} comment(s) confirmed absent — retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${delay}ms\n`,
    );
    await new Promise<void>((r) => setTimeout(r, delay));
    pending = stillMissing;
  }

  const errors = [
    ...[...failures].map(([finding, err]) => ({ finding, error: err.message })),
    ...[...unplaceable].map(([finding, error]) => ({ finding, error })),
  ];
  return { posted, errors, unverified };
}

const UNVERIFIED_NOTE =
  'could not verify whether this landed — the PR read-back failed; check the PR before re-running with --resume';

export async function runPost(opts: PostOptions): Promise<PostResult> {
  const { provider, ref: parsedRef } = resolvePr(opts.prUrl, undefined, opts.provider);
  const ref = opts.gather?.pr ?? parsedRef;

  const allFindings: Finding[] = opts.outputs.flatMap((o) => o.findings);
  const result: PostResult = { attempted: 0, posted: 0, skipped: 0, errors: [], verified: true };

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

  // Every finding is COUNTED once, however many write attempts it takes — the
  // count is the input size, not a running tally a partially-landed batch
  // could double.
  result.attempted = findings.length;
  const since = windowStart(opts.gather?.existingComments, Date.now());
  const unverified: Finding[] = [];

  // Batch path: one review with all inline comments (single write, immune to
  // the per-comment burst quota). On failure the PR is read back, and only the
  // findings that genuinely are not there fall through to per-comment posting.
  let remaining = findings;
  if (provider.postBatchComments) {
    const inline = findings.filter((f) => f.file && f.line);
    if (inline.length > 0) {
      const batch = await postBatchReconciling(provider, ref, headSha, inline, since);
      result.posted += batch.posted;
      unverified.push(...batch.unverified);
      // `missing` and `unverified` are disjoint by construction: an unverifiable
      // outcome yields no missing set, because we do not know what is missing.
      remaining = findings.filter((f) => !(f.file && f.line) || batch.missing.includes(f));
    }
  }

  const each = await postEachReconciling(provider, ref, remaining, headSha, since);
  result.posted += each.posted.length;
  result.errors.push(...each.errors);
  unverified.push(...each.unverified);
  for (const f of unverified) result.errors.push({ finding: f, error: UNVERIFIED_NOTE });
  result.verified = unverified.length === 0;

  // Report what the PR actually has, not what the write calls returned. This
  // number decides whether the user reaches for --resume, so a false negative
  // here is what duplicates a whole review.
  //
  // Deliberately one-way: errors may be promoted to posted, never the reverse.
  // Demoting on a stale read would mark a live comment un-posted and send the
  // next resume out to write it again — the very bug being fixed.
  if (result.errors.length > 0 || !result.verified) {
    const errored = new Set(result.errors.map((e) => e.finding));
    const landed = await readLanded(provider, ref, since, new Set([...errored].map(findingKey)));
    if (landed === null) {
      result.verified = false;
    } else {
      // A successful read tells us the whole truth, including about writes an
      // earlier read could not confirm.
      result.verified = true;
      // Reserve the comments the successful posts already account for, or an
      // errored finding can claim a comment that belongs to one that posted
      // fine and be promoted on the strength of it.
      for (const f of findings) if (!errored.has(f)) claim(landed, findingKey(f));
      const recovered = new Set(result.errors.filter((e) => claim(landed, findingKey(e.finding))));
      if (recovered.size > 0) {
        result.posted += recovered.size;
        result.errors = result.errors.filter((e) => !recovered.has(e));
        process.stderr.write(
          `[post] ${recovered.size} finding(s) reported an error but are on the PR — counting them as posted (a lost response, not a failed write)\n`,
        );
      }
    }
  }

  for (const e of result.errors) {
    process.stderr.write(`[post] not posted — ${e.finding.file ?? '(no file)'}:${e.finding.line ?? '?'}: ${e.error}\n`);
  }
  process.stderr.write(
    `[post] posted ${result.posted} / attempted ${result.attempted}; skipped ${result.skipped}; errors ${result.errors.length}${result.verified ? '' : ' (UNVERIFIED — the PR could not be read back)'}\n`,
  );
  return result;
}
