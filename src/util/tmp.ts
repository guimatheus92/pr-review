import { mkdtempSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrRef } from '../types.js';

export const RUNS_ROOT = join(homedir(), '.pr-review', 'runs');

export function ensureRunDir(ref?: Pick<PrRef, 'provider' | 'owner' | 'repo' | 'number'>): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = ref
    ? `${ref.provider}__${ref.owner}__${ref.repo}__${ref.number}__${stamp}`
    : `adhoc__${stamp}`;
  const outDir = join(RUNS_ROOT, id);
  mkdirSync(outDir, { recursive: true });
  return outDir;
}

export function makeTempDir(prefix = 'pr-review-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
