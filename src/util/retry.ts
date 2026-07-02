/**
 * Default backoff schedule for transient posting errors. Carried over from
 * the predecessor tool, where this spacing was enough for GitHub's burst
 * rejections (generic 422s under rapid comment writes) to clear on retry.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];

export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetriable: (err: Error) => boolean,
  label: string,
  backoffMs: readonly number[] = RETRY_BACKOFF_MS,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      if (!isRetriable(lastErr) || attempt === backoffMs.length) throw lastErr;
      const delay = backoffMs[attempt]!;
      process.stderr.write(
        `[retry] transient error on ${label} — retry ${attempt + 1}/${backoffMs.length} after ${delay}ms: ${lastErr.message.split('\n')[0]}\n`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error(`withRetry(${label}): unreachable`);
}
