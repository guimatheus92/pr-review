import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PACKS, loadConfig, type SkillPack } from '../config.js';
import { listPackFiles } from '../packs/load.js';
import {
  STALE_DAYS,
  ensurePacks,
  gitAvailable,
  packDir,
  packStatus,
  syncPacks,
  type GitExec,
} from '../packs/sync.js';
import { linguistCachePath, loadLinguist } from '../stack/linguist.js';
import { GLOBAL_PATH, readOrEmpty, writeConfig } from './configure.js';

function skillCount(pack: SkillPack, home?: string): number {
  const dir = packDir(pack, home);
  if (!existsSync(dir)) return 0;
  return listPackFiles(dir, pack.include, pack.exclude).length;
}

/** `pr-review packs list` — what is configured, what is on disk, how fresh. */
export function packsList(opts: { home?: string } = {}): void {
  const { config } = loadConfig(opts.home ? { homeOverride: opts.home } : {});
  if (config.skillPacks.length === 0) {
    console.log('No skill packs configured (skill_packs: [] disables them).');
    return;
  }
  console.log(`Skill packs (${config.skillPacks.length}) — root: ${join(opts.home ?? '~', '.pr-review', 'packs')}`);
  for (const pack of config.skillPacks) {
    const st = packStatus(pack, opts.home);
    if (!st.exists) {
      console.log(`  ✗ ${pack.name} — not cloned yet (${pack.git}); clones on the next review, or run \`pr-review packs sync\``);
      continue;
    }
    const commit = st.meta?.commit ? st.meta.commit.slice(0, 7) : '???????';
    const age = st.ageDays === null ? 'never synced' : `synced ${Math.floor(st.ageDays)}d ago`;
    const stale = st.ageDays === null || st.ageDays > STALE_DAYS ? '  ⚠ stale — run `pr-review packs sync`' : '';
    const mode = pack.mode === 'index' ? ' (index-only)' : '';
    console.log(`  ✓ ${pack.name}${mode} — ${skillCount(pack, opts.home)} skill(s), ${commit} (${st.meta?.commitDate?.slice(0, 10) ?? '?'}), ${age}${stale}`);
  }
  const linguist = linguistCachePath(opts.home);
  console.log(existsSync(linguist) ? `  ✓ Linguist languages.yml cached` : `  ✗ Linguist languages.yml not cached (downloads on first review or on sync)`);
}

/** `pr-review packs sync` — clone-or-pull every configured pack + refresh the Linguist cache. Exit 1 on any failure. */
export async function packsSync(opts: { home?: string; fetchFn?: typeof fetch } = {}): Promise<number> {
  const { config } = loadConfig(opts.home ? { homeOverride: opts.home } : {});
  if (!gitAvailable()) {
    console.error('git is not on PATH — install git to sync skill packs.');
    return 1;
  }
  const result = syncPacks(config.skillPacks, { home: opts.home });
  for (const s of result.synced) {
    console.log(`  ✓ ${s.name} @ ${s.commit?.slice(0, 7) ?? '?'} (${s.commitDate?.slice(0, 10) ?? '?'})`);
  }
  for (const f of result.failed) {
    console.error(`  ✗ ${f.name} — ${f.error}`);
  }
  const linguist = await loadLinguist({ home: opts.home, fetchFn: opts.fetchFn, force: true });
  console.log(linguist ? '  ✓ Linguist languages.yml refreshed' : '  ✗ Linguist languages.yml refresh failed (kept cache if any)');
  return result.failed.length > 0 ? 1 : 0;
}

/**
 * `pr-review packs add <owner/repo|url>` — append a pack to the global config and
 * clone it. Because `skill_packs` REPLACES (so `[]` can disable), an absent key
 * must first be materialized with the defaults — otherwise adding one pack would
 * silently drop the built-in three.
 */
export function packsAdd(spec: string, opts: { home?: string; git?: GitExec } = {}): number {
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec) && !/^(https?|git|ssh):/.test(spec) && !existsSync(spec)) {
    console.error(`not a pack source: ${spec} (expected owner/repo, a git URL, or a local path)`);
    return 1;
  }
  const path = opts.home ? join(opts.home, '.pr-review', 'config.yaml') : GLOBAL_PATH;
  const cfg = readOrEmpty(path);
  if (!Array.isArray(cfg.skill_packs)) {
    cfg.skill_packs = DEFAULT_PACKS.map((p) => ({ ...p }));
    console.log('(skill_packs was not set — materialized the default pack list into the config first)');
  }
  const already = cfg.skill_packs.some(
    (p) => p === spec || (typeof p === 'object' && p !== null && (p as { git?: string }).git === spec),
  );
  if (already) {
    console.log(`${spec} is already configured — nothing to do.`);
    return 0;
  }
  cfg.skill_packs.push(spec);
  writeConfig(cfg, path);
  console.log(`added ${spec} to ${path}`);

  const { config } = loadConfig(opts.home ? { homeOverride: opts.home } : {});
  const pack = config.skillPacks.find((p) => p.git === spec);
  if (pack) {
    const res = ensurePacks([pack], { home: opts.home, git: opts.git });
    for (const w of res.warnings) console.error(w);
    if (res.cloned.length > 0) console.log(`cloned ${pack.name} — ${skillCount(pack, opts.home)} skill(s)`);
  }
  return 0;
}

export interface SuggestHit {
  name: string;
  installs: number;
  source: string;
}

/**
 * skills.sh search — undocumented endpoint, so parse defensively (object with a
 * `skills` array today; accept a bare array too) and fail soft to [].
 */
export async function searchSkillsSh(tag: string, fetchFn: typeof fetch = fetch, timeoutMs = 5000): Promise<SuggestHit[]> {
  try {
    const res = await fetchFn(`https://skills.sh/api/search?q=${encodeURIComponent(tag)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as unknown;
    const rows = Array.isArray(json) ? json : ((json as { skills?: unknown[] })?.skills ?? []);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        name: String(r.name ?? ''),
        installs: Number(r.installs ?? 0),
        source: String(r.source ?? ''),
      }))
      .filter((r) => r.name && r.source)
      .sort((a, b) => b.installs - a.installs);
  } catch {
    return [];
  }
}

/** `owner/repo/skill` → `owner/repo` (the unit `packs add` installs). */
function repoOf(source: string): string {
  const parts = source.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : source;
}

/**
 * `pr-review packs suggest <tag>...` — search the skills.sh directory per stack
 * tag and print candidates with install counts. NEVER installs anything:
 * third-party prompt content only enters a review through an explicit
 * `packs add` / `skill_packs` edit.
 */
export async function packsSuggest(tags: string[], opts: { home?: string; fetchFn?: typeof fetch } = {}): Promise<number> {
  if (tags.length === 0) {
    console.error('usage: pr-review packs suggest <tag> [...more tags] (e.g. `packs suggest python django`)');
    return 1;
  }
  const { config } = loadConfig(opts.home ? { homeOverride: opts.home } : {});
  const configured = new Set(config.skillPacks.map((p) => p.git));
  let printedAny = false;
  for (const tag of tags) {
    const hits = (await searchSkillsSh(tag, opts.fetchFn)).filter((h) => !configured.has(repoOf(h.source)));
    console.log(`\n${tag}:`);
    if (hits.length === 0) {
      console.log('  (no results — skills.sh unreachable or nothing indexed)');
      continue;
    }
    printedAny = true;
    for (const h of hits.slice(0, 5)) {
      console.log(`  ${h.name}  (${h.installs.toLocaleString('en-US')} installs)  ${h.source}`);
      console.log(`      install the repo: pr-review packs add ${repoOf(h.source)}`);
    }
  }
  if (printedAny) {
    console.log(
      '\nNote: these are third-party prompts ranked by installs, not vetted content — review a repo before adding it.',
    );
  }
  return 0;
}
