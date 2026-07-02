import { detectProvider } from '../providers/index.js';
import { buildValidLinesMap, snapLineToDiff } from '../dispatch/line-snap.js';
import type { ChangedFile, Finding, GatherOutput, ReviewerOutput } from '../types.js';
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
  const provider = opts.provider ?? detectProvider(opts.prUrl);
  const ref = provider.parseUrl(opts.prUrl);
  if (!ref) throw new Error(`Failed to parse PR URL: ${opts.prUrl}`);

  const allFindings: Finding[] = opts.outputs.flatMap((o) => o.findings);
  const result: PostResult = { attempted: 0, posted: 0, skipped: 0, errors: [] };

  if (!opts.publish) {
    result.skipped = allFindings.length;
    process.stderr.write(`[post] dry-run: would have posted ${allFindings.length} comment(s)\n`);
    return result;
  }

  // Snap reviewer-supplied lines to the nearest valid diff line so inline
  // comments do not 422 the batch review. On GitHub, findings that cannot
  // anchor where they point are re-anchored instead of dropped — every
  // finding must land as a resolvable inline review thread.
  let findings = allFindings;
  if (opts.gather) {
    const snap = snapFindingsToDiff(allFindings, opts.gather.changedFiles, provider.name === 'github');
    findings = snap.findings;
    if (snap.snapped > 0) process.stderr.write(`[post] snapped ${snap.snapped} finding line(s) to the diff\n`);
    if (snap.reanchored > 0) {
      process.stderr.write(
        `[post] re-anchored ${snap.reanchored} finding(s) without a diff location to ${snap.anchor!.file}:${snap.anchor!.line}\n`,
      );
    }
  }

  const headSha = opts.gather?.metadata.headSha ?? (await provider.fetchMetadata(ref)).headSha;

  // Batch path: one review with all inline comments (single write, immune to
  // the per-comment burst quota). Falls back to per-comment on batch failure.
  let remaining = findings;
  if (provider.postBatchComments) {
    const inline = findings.filter((f) => f.file && f.line);
    if (inline.length > 0) {
      const comments: BatchComment[] = inline.map((f) => ({
        path: f.file!,
        line: f.line!,
        body: f.body.trim(),
      }));
      try {
        const batch = await provider.postBatchComments(ref, headSha, comments);
        result.attempted += inline.length;
        result.posted += batch.posted;
        remaining = findings.filter((f) => !(f.file && f.line));
        process.stderr.write(`[post] posted ${batch.posted} inline comment(s) as one review\n`);
      } catch (err) {
        // GitHub's create-review call is atomic — a failed batch posted
        // nothing, so re-attempting every inline finding per-comment cannot
        // double-post. attempted is only counted in the per-comment loop.
        process.stderr.write(
          `[post] batch review failed (${(err as Error).message.split('\n')[0]}); falling back to per-comment posting\n`,
        );
      }
    }
  }

  for (const f of remaining) {
    result.attempted++;
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
  process.stderr.write(
    `[post] posted ${result.posted} / attempted ${result.attempted}; skipped ${result.skipped}; errors ${result.errors.length}\n`,
  );
  return result;
}
