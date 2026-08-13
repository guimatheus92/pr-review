import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrRef } from '../types.js';

/**
 * Flatten a PR path component (owner/repo) for filesystem use. GitLab nested
 * namespaces put '/' in owner, and URL-decoded components can smuggle
 * separators or dot segments (`…%2F..%2F…`) that would otherwise escape the
 * runs/cache roots. Plain GitHub/ADO names pass through unchanged. Lives in
 * the util leaf so cache/keys.ts and this file both import it downward — one
 * flattener shared by run-dir naming, cache paths, and cache clearing, so
 * writer/reader/clearer never drift. The nested-run-dir stake: `--detach`
 * returns `basename(outDir)` as the run-id, so a nested run dir would lose
 * its parent prefix and `status <run-id>` could never resolve it.
 */
export function safeSegment(s: string): string {
  const flat = s.replace(/[/\\]/g, '-');
  return /^\.{1,2}$/.test(flat) ? flat.replace(/\./g, '_') : flat;
}

export function safeOwner(ref: Pick<PrRef, 'owner'>): string {
  return safeSegment(ref.owner);
}

export const RUNS_ROOT = join(homedir(), '.pr-review', 'runs');

/**
 * Fatal-error artifact of a run, surfaced inline by `status` on a failed run.
 * Producers: the cli.ts review catch (thrown errors) and finalizeReview
 * (pipeline failure). Lives here in the shared util layer — like PROGRESS_FILE
 * and MARKER_FILE — so producers and the consumer all import it downward.
 */
export const ERROR_FILE = 'error.txt';

export function ensureRunDir(ref?: Pick<PrRef, 'provider' | 'owner' | 'repo' | 'number'>): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = ref
    ? `${ref.provider}__${safeOwner(ref)}__${safeSegment(ref.repo)}__${ref.number}__${stamp}`
    : `adhoc__${stamp}`;
  const outDir = join(RUNS_ROOT, id);
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

export function makeTempDir(prefix = 'pr-review-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
