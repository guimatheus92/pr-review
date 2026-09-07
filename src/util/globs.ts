function escapeRegex(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiled patterns, memoized for the life of the process.
 *
 * `matchesAny` compiles inside its `.some()`, so without this a 500-file PR
 * recompiles every pattern 500 times — and `DEFAULT_EXCLUDES` alone is 31 of
 * them. It also bounds the damage of a pathological pattern to one match rather
 * than one per path.
 */
const compiled = new Map<string, RegExp>();

/** Matches nothing. For an exclusion list that is the safe direction: the file is reviewed, not silently hidden. */
const NEVER = /(?!)/;
const MAX_PATTERN_LENGTH = 512;
/** `**` compiles to `.*`; several of them in one anchored pattern is what backtracks. Real patterns use one or two. */
const MAX_WILD_SEGMENTS = 4;
const rejected = new Set<string>();

/**
 * Refuse a pattern that would cost more to match than it can be worth.
 *
 * `diff_excludes` can come from the checkout's own `.pr-review.yaml`, i.e. from
 * the branch under review. Measured on this repo: `**a**a**a**a**a**a**a**a**b`
 * against one 40-character path takes **3.7 seconds** — `^.*a.*a.*…$` is
 * catastrophic backtracking — and `matchesAny` compiles inside its `.some()`,
 * so a 501-file PR would pay it once per file.
 */
function tooComplex(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return true;
  const wild = pattern.split('**').length - 1;
  return wild > MAX_WILD_SEGMENTS;
}

function globToRegex(pattern: string): RegExp {
  const hit = compiled.get(pattern);
  if (hit) return hit;
  if (tooComplex(pattern)) {
    if (!rejected.has(pattern)) {
      rejected.add(pattern);
      process.stderr.write(
        `[globs] ignoring an over-complex glob (${pattern.length} chars, ${pattern.split('**').length - 1} '**' segments): matching it would cost more than the pattern can be worth\n`,
      );
    }
    compiled.set(pattern, NEVER);
    return NEVER;
  }
  const built = buildGlobRegex(pattern);
  compiled.set(pattern, built);
  return built;
}

function buildGlobRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const next = pattern[i + 2];
        if (next === '/') {
          regex += '(?:.*/)?';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      regex += '[^/]';
      i += 1;
    } else if (c === '/') {
      regex += '/';
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regex += escapeRegex(c);
        i += 1;
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map((s) => globToRegex(s).source.slice(1, -1));
        regex += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      regex += escapeRegex(c);
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

export function matchesAny(filePath: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some((p) => globToRegex(p).test(normalized));
}

export function filterFiles<T extends { path: string }>(files: T[], patterns: string[]): T[] {
  if (patterns.length === 0) return files;
  return files.filter((f) => matchesAny(f.path, patterns));
}
