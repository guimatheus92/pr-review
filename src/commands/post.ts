import { detectProvider } from '../providers/index.js';
import type { Finding, ReviewerOutput } from '../types.js';

interface PostOptions {
  prUrl: string;
  outputs: ReviewerOutput[];
  publish: boolean;
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

  for (const f of allFindings) {
    result.attempted++;
    try {
      const out = await provider.postLineComment(ref, f);
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
