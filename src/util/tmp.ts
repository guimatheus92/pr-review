import { mkdtempSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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

/** Flatten any name (pass name, reviewer name) into a filename-safe token. */
export function sanitizeForFilename(name: string): string {
  const readable = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 80) || 'reviewer';
  const digest = createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 12);
  return `${readable}--${digest}`;
}

export const RUNS_ROOT = join(homedir(), '.pr-review', 'runs');

/** Recovery authority lives outside the runtime-writable run directory. */
export function controlDirForRun(runDir: string, home = homedir()): string {
  const absolute = resolve(runDir);
  const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16);
  return join(home, '.pr-review', 'control', `${basename(runDir)}--${digest}`);
}

/**
 * Fatal-error artifact of a run, surfaced inline by `status` on a failed run.
 * Producers: the cli.ts review catch (thrown errors) and finalizeReview
 * (pipeline failure). Lives here in the shared util layer — like PROGRESS_FILE
 * and MARKER_FILE — so producers and the consumer all import it downward.
 */
export const ERROR_FILE = 'error.txt';

export function ensureRunDir(ref?: Pick<PrRef, 'provider' | 'owner' | 'repo' | 'number'>, home?: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = ref
    ? `${ref.provider}__${safeOwner(ref)}__${safeSegment(ref.repo)}__${ref.number}__${stamp}`
    : `adhoc__${stamp}`;
  const outDir = join(home ? join(home, '.pr-review', 'runs') : RUNS_ROOT, id);
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

export function makeTempDir(prefix = 'pr-review-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
