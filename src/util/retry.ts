/**
 * Default backoff schedule for transient posting errors. Carried over from
 * the predecessor tool, where this spacing was enough for GitHub's burst
 * rejections (generic 422s under rapid comment writes) to clear on retry.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];

/**
 * Node/undici error codes that mean "the network got in the way", not "the
 * server answered no".
 *
 * `fetch` reports every one of these as the message `fetch failed` with the
 * real code buried in `cause` — and with NO `status` property, which is what
 * every provider's transient check reads. So the most transient failure there
 * is was classified permanent by all three: a live GitLab cell lost one comment
 * of 57 to `fetch failed`, and because it was not retriable the reconcile-then-
 * retry path in `runPost` — which exists for exactly this — never ran.
 *
 * Retrying stays safe because this only makes an error ELIGIBLE for that path.
 * A write is still re-issued solely after `readLanded` confirms the comment is
 * genuinely absent (INV-POST-04); nothing here enables a blind retry.
 */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'ENETRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EPROTO',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_STREAM_PREMATURE_CLOSE',
]);

/** True when the failure was the transport, at any depth of the `cause` chain. */
export function isNetworkError(err: unknown): boolean {
  // Bounded walk: an undici error nests the real code one or two levels down,
  // and a cause chain can be circular.
  for (let node = err, depth = 0; node && typeof node === 'object' && depth < 5; depth++) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
    const message = (node as { message?: unknown }).message;
    if (typeof message === 'string' && /^fetch failed$|socket hang up|network socket disconnected|premature close/i.test(message)) {
      return true;
    }
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

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
