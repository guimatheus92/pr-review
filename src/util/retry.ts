/**
 * Backoff schedule tuned in the predecessor tool for GitHub's undocumented
 * per-PR write burst quota (~60 writes/min, reported as a generic 422):
 * ~22s cumulative covers the worst observed burst window.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];

export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetriable: (err: Error) => boolean,
  label: string,
): Promise<T> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      if (!isRetriable(lastErr) || attempt === RETRY_BACKOFF_MS.length) throw lastErr;
      const delay = RETRY_BACKOFF_MS[attempt]!;
      process.stderr.write(
        `[retry] transient error on ${label} — retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${delay}ms: ${lastErr.message.split('\n')[0]}\n`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr ?? new Error(`withRetry(${label}): unreachable`);
}
