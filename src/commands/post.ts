import { detectProvider } from '../providers/index.js';
import { buildValidLinesMap, snapLineToDiff } from '../dispatch/line-snap.js';
import type { Finding, GatherOutput, ReviewerOutput } from '../types.js';
import type { BatchComment } from '../providers/types.js';

interface PostOptions {
  prUrl: string;
  outputs: ReviewerOutput[];
  publish: boolean;
  /** When provided, enables line snapping (via changedFiles patches) and skips the head-SHA fetch. */
  gather?: GatherOutput;
}

export interface PostResult {
  attempted: number;
  posted: number;
  skipped: number;
  errors: { finding: Finding; error: string }[];
}

export async function runPost(opts: PostOptions): Promise<PostResult> {
  const provider = detectProvider(opts.prUrl);
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
  // comments do not 422 and silently degrade to top-level comments.
  let findings = allFindings;
  if (opts.gather) {
    const validLines = buildValidLinesMap(opts.gather.changedFiles);
    let snapped = 0;
    findings = allFindings.map((f) => {
      if (!f.file || !f.line) return f;
      const snappedLine = snapLineToDiff(validLines, f.file, f.line);
      if (snappedLine === null || snappedLine === f.line) return f;
      snapped++;
      return { ...f, line: snappedLine };
    });
    if (snapped > 0) process.stderr.write(`[post] snapped ${snapped} finding line(s) to the diff\n`);
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
        result.skipped++;
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
