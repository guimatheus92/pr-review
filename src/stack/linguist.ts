import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * GitHub's own language database — the same data that powers repo language
 * bars. Nothing hand-written here: extensions, filenames, and aliases all come
 * from upstream; `packs sync` refreshes the cached copy.
 */
export const LINGUIST_URL =
  'https://raw.githubusercontent.com/github-linguist/linguist/main/lib/linguist/languages.yml';

export function linguistCachePath(home: string = homedir()): string {
  return join(home, '.pr-review', 'cache', 'linguist-languages.yml');
}

export interface LinguistIndex {
  /** '.tf' → lowercase tags (language name + aliases), unioned across languages claiming the ext. */
  byExt: Map<string, Set<string>>;
  /** 'dockerfile' → tags, for extension-less well-known filenames. */
  byFilename: Map<string, Set<string>>;
}

interface RawLang {
  extensions?: unknown[];
  filenames?: unknown[];
  aliases?: unknown[];
}

export function parseLinguist(yamlText: string): LinguistIndex {
  const doc = parseYaml(yamlText) as Record<string, RawLang> | null;
  const byExt = new Map<string, Set<string>>();
  const byFilename = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, tags: string[]) => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    for (const t of tags) set.add(t);
  };
  if (doc && typeof doc === 'object') {
    for (const [name, lang] of Object.entries(doc)) {
      if (!lang || typeof lang !== 'object') continue;
      const tags = [name, ...(Array.isArray(lang.aliases) ? lang.aliases : [])].map((t) =>
        String(t).toLowerCase(),
      );
      for (const ext of Array.isArray(lang.extensions) ? lang.extensions : []) {
        add(byExt, String(ext).toLowerCase(), tags);
      }
      for (const fn of Array.isArray(lang.filenames) ? lang.filenames : []) {
        add(byFilename, String(fn).toLowerCase(), tags);
      }
    }
  }
  return { byExt, byFilename };
}

/** Tags for one changed path: filename exact match, then every dotted suffix ('a.cs.pp' → '.cs.pp', '.pp'). */
export function languageTags(index: LinguistIndex, path: string): string[] {
  const base = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const out = new Set<string>();
  for (const t of index.byFilename.get(base) ?? []) out.add(t);
  const parts = base.split('.');
  for (let i = 1; i < parts.length; i++) {
    const suffix = '.' + parts.slice(i).join('.');
    for (const t of index.byExt.get(suffix) ?? []) out.add(t);
  }
  return [...out];
}

/**
 * Cached-first load. A fetch failure with no cache returns null (one warning);
 * a failed forced refresh falls back to the existing cache.
 */
export async function loadLinguist(
  opts: { home?: string; fetchFn?: typeof fetch; force?: boolean; timeoutMs?: number } = {},
): Promise<LinguistIndex | null> {
  const cache = linguistCachePath(opts.home);
  const readCache = (): LinguistIndex | null => {
    try {
      return parseLinguist(readFileSync(cache, 'utf8'));
    } catch {
      return null;
    }
  };
  if (!opts.force && existsSync(cache)) {
    const cached = readCache();
    if (cached) return cached;
  }
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  try {
    const res = await fetchFn(LINGUIST_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const index = parseLinguist(text); // validate before caching
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, text, 'utf8');
    return index;
  } catch (err) {
    if (existsSync(cache)) {
      const cached = readCache();
      if (cached) return cached;
    }
    const msg = ((err as Error).message ?? String(err)).split('\n')[0];
    process.stderr.write(
      `[stack] Linguist languages.yml not cached and download failed (${msg}) — language tags unavailable until \`pr-review packs sync\` runs online\n`,
    );
    return null;
  }
}
