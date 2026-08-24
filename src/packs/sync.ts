import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SkillPack } from '../config.js';
import { binaryOnPath } from '../dispatch/runtime.js';

/** A pack unsynced longer than this warns on every review. */
export const STALE_DAYS = 30;

/** Seam for tests: run git with args (optionally in cwd), return stdout. Throws on failure. */
export type GitExec = (args: string[], cwd?: string) => string;

const GIT_TIMEOUT_MS = 5 * 60 * 1000;

const defaultGit: GitExec = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // A pack source that wants credentials must fail, not hang the review on an
    // invisible prompt; ditto a network stall.
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });

/**
 * Only plain fetch transports reach `git clone` argv. Config values are
 * repo-controlled (.pr-review.yaml), so exotic transports (`ext::` runs a
 * command, `--upload-pack=` smuggles one) and dash-prefixed values must never
 * make it into the argv. Local paths are allowed only when they exist (tests,
 * private mirrors).
 */
export function isSafeGitSource(url: string): boolean {
  if (!url || url.startsWith('-')) return false;
  if (/^(https?|ssh):\/\//i.test(url)) return true;
  if (/^git@[\w.-]+:/.test(url)) return true;
  return existsSync(url);
}

export function isSafeRef(ref: string): boolean {
  return /^[\w./-]+$/.test(ref) && !ref.startsWith('-');
}

export function packsRoot(home: string = homedir()): string {
  return join(home, '.pr-review', 'packs');
}

export function packDir(pack: Pick<SkillPack, 'name'>, home?: string): string {
  return join(packsRoot(home), pack.name);
}

/** Sibling of the checkout, never inside it — metadata must not dirty the tree. */
export function packMetaPath(pack: Pick<SkillPack, 'name'>, home?: string): string {
  return join(packsRoot(home), `${pack.name}.json`);
}

/** 'owner/repo' shorthand → GitHub https URL; anything else (URL, local path) passes through. */
export function gitUrl(pack: Pick<SkillPack, 'git'>): string {
  return /^[\w.-]+\/[\w.-]+$/.test(pack.git) ? `https://github.com/${pack.git}.git` : pack.git;
}

export interface PackMeta {
  git: string;
  ref?: string;
  syncedAt: string;
  commit?: string;
  commitDate?: string;
}

export function readPackMeta(pack: Pick<SkillPack, 'name'>, home?: string): PackMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(packMetaPath(pack, home), 'utf8')) as PackMeta;
    return parsed && typeof parsed.syncedAt === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function gitAvailable(): boolean {
  return binaryOnPath('git');
}

function isGitCheckout(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function firstLine(err: unknown): string {
  const e = err as Error & { stderr?: string };
  const text = (e.stderr ?? e.message ?? String(err)).toString().trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // git prints progress banners ("Cloning into…") before the real error —
  // prefer the fatal/error line, then fall back to the last line.
  const real = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[lines.length - 1] ?? 'unknown error';
  // Third-party stderr goes to the terminal — strip control chars (log forging).
  // eslint-disable-next-line no-control-regex
  return real.replace(/[\u0000-\u001f\u007f]/g, '');
}

function writeMeta(pack: SkillPack, home: string | undefined, git: GitExec): PackMeta {
  const dir = packDir(pack, home);
  let commit: string | undefined;
  let commitDate: string | undefined;
  try {
    commit = git(['rev-parse', 'HEAD'], dir).trim();
    commitDate = git(['log', '-1', '--format=%cI'], dir).trim();
  } catch {
    // metadata is best-effort; syncedAt alone still drives staleness
  }
  const meta: PackMeta = { git: pack.git, ref: pack.ref, syncedAt: new Date().toISOString(), commit, commitDate };
  try {
    writeFileSync(packMetaPath(pack, home), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // best-effort
  }
  return meta;
}

export interface PackStatus {
  dir: string;
  exists: boolean;
  isGit: boolean;
  meta: PackMeta | null;
  /** Days since last sync; null when no meta exists (counts as stale). */
  ageDays: number | null;
}

export function packStatus(pack: SkillPack, home?: string): PackStatus {
  const dir = packDir(pack, home);
  const exists = existsSync(dir);
  const meta = readPackMeta(pack, home);
  let ageDays: number | null = null;
  if (meta) {
    const synced = Date.parse(meta.syncedAt);
    if (!Number.isNaN(synced)) ageDays = (Date.now() - synced) / 86_400_000;
  }
  return { dir, exists, isGit: exists && isGitCheckout(dir), meta, ageDays };
}

export interface EnsureResult {
  /** Packs whose checkout is present (pre-existing or just cloned). */
  present: SkillPack[];
  /** Pack names cloned by THIS call (first use). */
  cloned: string[];
  warnings: string[];
}

/**
 * Review-time guarantee: clone whatever is missing, never pull (sync is the
 * explicit update path). Every failure is a warning, never fatal — a review
 * must run with whatever packs are on disk.
 */
export function ensurePacks(packs: SkillPack[], opts: { home?: string; git?: GitExec } = {}): EnsureResult {
  const present: SkillPack[] = [];
  const cloned: string[] = [];
  const warnings: string[] = [];
  if (packs.length === 0) return { present, cloned, warnings };
  const git = opts.git ?? defaultGit;
  const canClone = opts.git ? true : gitAvailable();
  let warnedNoGit = false;

  for (const pack of packs) {
    const dir = packDir(pack, opts.home);
    if (existsSync(dir)) {
      if (!isGitCheckout(dir)) {
        warnings.push(
          `[packs] ${pack.name}: ${dir} exists but is not a git checkout — delete it or rename the pack; skipped`,
        );
        continue;
      }
      present.push(pack);
      const st = packStatus(pack, opts.home);
      if (st.ageDays === null || st.ageDays > STALE_DAYS) {
        const age = st.ageDays === null ? 'unknown age' : `${Math.floor(st.ageDays)} days old`;
        warnings.push(`[packs] ${pack.name}: last sync ${age} — run \`pr-review packs sync\` to refresh review knowledge`);
      }
      continue;
    }
    if (!canClone) {
      if (!warnedNoGit) {
        warnings.push('[packs] git not found on PATH — cannot clone missing skill packs; reviewing with what is on disk');
        warnedNoGit = true;
      }
      continue;
    }
    const url = gitUrl(pack);
    if (!isSafeGitSource(url) || (pack.ref !== undefined && !isSafeRef(pack.ref))) {
      warnings.push(`[packs] ${pack.name}: refusing unsafe git source/ref in skill_packs — skipped`);
      continue;
    }
    try {
      mkdirSync(packsRoot(opts.home), { recursive: true });
      const args = ['clone', '--depth', '1', '--single-branch'];
      if (pack.ref) args.push('--branch', pack.ref);
      args.push(url, dir);
      git(args);
      // An interrupted clone can leave a .git dir with no commit — verify before trusting it.
      git(['rev-parse', '--verify', 'HEAD'], dir);
      writeMeta(pack, opts.home, git);
      present.push(pack);
      cloned.push(pack.name);
    } catch (err) {
      // git usually removes its own failed target; belt and braces for partials
      // (including a .git dir that never got a commit — rev-parse above threw).
      if (existsSync(dir)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // leave it; the not-a-git-checkout warning will fire next run
        }
      }
      warnings.push(`[packs] ${pack.name}: clone failed — ${firstLine(err)}; continuing without it`);
    }
  }
  return { present, cloned, warnings };
}

export interface SyncResult {
  synced: { name: string; commit?: string; commitDate?: string }[];
  failed: { name: string; error: string }[];
}

/** `pr-review packs sync`: clone-or-pull every configured pack, rewrite metadata. */
export function syncPacks(packs: SkillPack[], opts: { home?: string; git?: GitExec } = {}): SyncResult {
  const result: SyncResult = { synced: [], failed: [] };
  const git = opts.git ?? defaultGit;
  if (!opts.git && !gitAvailable()) {
    for (const pack of packs) result.failed.push({ name: pack.name, error: 'git not found on PATH' });
    return result;
  }
  for (const pack of packs) {
    const dir = packDir(pack, opts.home);
    try {
      const url = gitUrl(pack);
      if (!isSafeGitSource(url) || (pack.ref !== undefined && !isSafeRef(pack.ref))) {
        result.failed.push({ name: pack.name, error: 'refusing unsafe git source/ref in skill_packs' });
        continue;
      }
      if (!existsSync(dir)) {
        mkdirSync(packsRoot(opts.home), { recursive: true });
        const args = ['clone', '--depth', '1', '--single-branch'];
        if (pack.ref) args.push('--branch', pack.ref);
        args.push(url, dir);
        try {
          git(args);
          git(['rev-parse', '--verify', 'HEAD'], dir);
        } catch (cloneErr) {
          // Same belt-and-braces as ensurePacks: never leave a wedged half-clone.
          if (existsSync(dir)) {
            try {
              rmSync(dir, { recursive: true, force: true });
            } catch {
              // next run's not-a-git-checkout warning covers it
            }
          }
          throw cloneErr;
        }
      } else if (!isGitCheckout(dir)) {
        result.failed.push({ name: pack.name, error: `${dir} exists but is not a git checkout` });
        continue;
      } else {
        const prior = readPackMeta(pack, opts.home);
        // pull keeps tracking whatever the clone was made from — a config ref
        // OR source change would silently not take effect.
        if (prior && (prior.ref ?? null) !== (pack.ref ?? null)) {
          result.failed.push({
            name: pack.name,
            error: `configured ref changed (${prior.ref ?? 'default'} → ${pack.ref ?? 'default'}) — delete ${dir} and re-sync`,
          });
          continue;
        }
        if (prior && prior.git !== pack.git) {
          result.failed.push({
            name: pack.name,
            error: `configured git source changed (${prior.git} → ${pack.git}) — delete ${dir} and re-sync`,
          });
          continue;
        }
        git(['pull', '--ff-only', '--quiet'], dir);
      }
      const meta = writeMeta(pack, opts.home, git);
      result.synced.push({ name: pack.name, commit: meta.commit, commitDate: meta.commitDate });
    } catch (err) {
      const line = firstLine(err);
      // The force-push hint only fits an actual failed pull on an existing checkout.
      const hint = /non-fast-forward|not possible to fast-forward|rejected/i.test(line)
        ? ` (upstream rewrote history — delete ${dir} and re-sync)`
        : '';
      result.failed.push({ name: pack.name, error: line + hint });
    }
  }
  return result;
}
