/**
 * Human-readable detail from a failed execFileSync/execSync call: the exit
 * code/errno plus the captured stderr, falling back to the Error message.
 * Shared by the provider auth fallbacks so `gh`/`az` failures format
 * identically and future tweaks happen in one place.
 */
export function execErrorDetail(e: unknown): string {
  const err = e as Error & { code?: string; status?: number; stderr?: string | Buffer };
  return [err.code ?? err.status, err.stderr?.toString().trim() || err.message]
    .filter(Boolean)
    .join(': ');
}
