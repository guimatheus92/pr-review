import { realpathSync } from 'node:fs';

/**
 * `realpathSync` that also folds Windows 8.3 short path components.
 *
 * `realpathSync.native` canonicalizes `C:\Users\RUNNER~1\...` to
 * `C:\Users\runneradmin\...`; the JavaScript implementation resolves symlinks but
 * leaves the short form intact. Every containment check in this codebase compares a
 * path obtained from one source (`git rev-parse`, a manifest, a CLI argument) against
 * one obtained from another (`os.tmpdir()`, a directory walk) — and those sources do
 * not agree on short vs long form. The mismatch reads as "outside the checkout", so a
 * legitimate skill, manifest or plugin file is silently refused. Observed on CI:
 * Windows runners have a `runneradmin` home, which mangles to `RUNNER~1`, while a
 * developer whose username is 8 characters or fewer never reproduces it.
 *
 * Semantics otherwise match `realpathSync`, including throwing when the path does not
 * exist — callers rely on that to fail closed.
 */
export function realpathCanonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Genuine ENOENT rethrows here; this only covers native being unavailable.
    return realpathSync(path);
  }
}

/**
 * One spelling for every path comparison against a PR's changed paths: forward
 * slashes, NFC, lowercase — on EVERY platform. Folding only on win32 left a hole on
 * macOS, whose default filesystem is case-insensitive too: a PR could commit a link
 * at `.Agents/skills`, have the fixed lowercase discovery root find it, and never
 * match the case-sensitive comparison. A false positive here fails closed; a false
 * negative is a hole.
 */
export function foldPath(path: string): string {
  return path.replace(/\\/g, '/').normalize('NFC').toLowerCase();
}
