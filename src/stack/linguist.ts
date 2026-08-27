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
  /** '.tf' → canonical lowercase language names, unioned across languages claiming the extension. */
  byExt: Map<string, Set<string>>;
  /** 'dockerfile' → canonical language names, for extension-less well-known filenames. */
  byFilename: Map<string, Set<string>>;
  /** Canonical language name → lowercase aliases, used only to resolve ambiguous claims. */
  aliasesByName: Map<string, Set<string>>;
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
  const aliasesByName = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: string, language: string) => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(language);
  };
  if (doc && typeof doc === 'object') {
    for (const [name, lang] of Object.entries(doc)) {
      if (!lang || typeof lang !== 'object') continue;
      const canonical = name.toLowerCase();
      aliasesByName.set(
        canonical,
        new Set((Array.isArray(lang.aliases) ? lang.aliases : []).map((alias) => String(alias).toLowerCase())),
      );
      for (const ext of Array.isArray(lang.extensions) ? lang.extensions : []) {
        add(byExt, String(ext).toLowerCase(), canonical);
      }
      for (const fn of Array.isArray(lang.filenames) ? lang.filenames : []) {
        add(byFilename, String(fn).toLowerCase(), canonical);
      }
    }
  }
  return { byExt, byFilename, aliasesByName };
}

/** Canonical languages for one changed path, optionally narrowed by known ecosystem/dependency tags. */
export function languageTags(index: LinguistIndex, path: string, preferredTags: Iterable<string> = []): string[] {
  const base = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  const out = new Set<string>();
  const preferred = new Set([...preferredTags].map((tag) => tag.toLowerCase()));
  const extension = base.includes('.') ? base.split('.').at(-1) : undefined;
  if (extension) preferred.add(extension);
  const addCandidates = (candidates: Set<string> | undefined) => {
    if (!candidates) return;
    let selected = [...candidates];
    if (selected.length > 1 && preferred.size > 0) {
      const supported = selected.filter(
        (name) => preferred.has(name) || [...(index.aliasesByName.get(name) ?? [])].some((alias) => preferred.has(alias)),
      );
      if (supported.length > 0) selected = supported;
    }
    for (const name of selected) out.add(name);
  };
  const filenameCandidates = index.byFilename.get(base);
  if (filenameCandidates) {
    addCandidates(filenameCandidates);
    return [...out];
  }
  const parts = base.split('.');
  for (let i = 1; i < parts.length; i++) {
    const suffix = '.' + parts.slice(i).join('.');
    addCandidates(index.byExt.get(suffix));
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
    const index = parseLinguist(text);
    // Actually validate before caching: a 200 serving an HTML error page parses
    // to an empty index and would poison the cache permanently. Real
    // languages.yml carries ~1000 languages; hundreds of extensions is the floor.
    if (index.byExt.size < 100) {
      throw new Error(`response does not look like languages.yml (${index.byExt.size} extensions parsed)`);
    }
    mkdirSync(dirname(cache), { recursive: true });
    writeFileSync(cache, text, 'utf8');
    return index;
  } catch (err) {
    if (existsSync(cache)) {
      const cached = readCache();
      if (cached) {
        if (opts.force) {
          process.stderr.write(
            `[stack] Linguist refresh failed (${((err as Error).message ?? '').split('\n')[0]}) — keeping the cached copy\n`,
          );
        }
        return cached;
      }
    }
    const msg = ((err as Error).message ?? String(err)).split('\n')[0];
    process.stderr.write(
      `[stack] Linguist languages.yml not cached and download failed (${msg}) — language tags unavailable until \`pr-review packs sync\` runs online\n`,
    );
    return null;
  }
}
