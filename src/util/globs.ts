function escapeRegex(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function globToRegex(pattern: string): RegExp {
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
