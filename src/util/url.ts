/**
 * Parse an http(s) URL; null for anything else. Shared by every provider's
 * parseUrl and by detectProvider so the two guards cannot drift.
 */
export function parseHttpUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
}

/**
 * decodeURIComponent that falls back to the raw segment on a malformed escape
 * (`%zz`, lone `%`). new URL() accepts those, so an unguarded decode would
 * throw a URIError out of parseUrl — which is contracted to return null, never
 * throw — and surface as a stack trace instead of the friendly URL error.
 */
export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
