import type { ChangedFile } from '../types.js';

/**
 * Valid NEW-side line numbers for one unified-diff patch: added (`+`) and
 * context (` `) lines. Deleted lines are not addressable for inline comments,
 * and anything outside these sets gets HTTP 422 from the providers.
 */
export function validLinesFromPatch(patch: string): Set<number> {
  const valid = new Set<number>();
  let newLine = 0;
  for (const ln of patch.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(ln);
    if (m) {
      newLine = parseInt(m[1]!, 10) - 1;
      continue;
    }
    if (ln.startsWith('+++') || ln.startsWith('---')) continue;
    if (ln.startsWith('\\')) continue; // "\ No newline at end of file"
    if (ln.startsWith('+')) {
      newLine++;
      valid.add(newLine);
    } else if (ln.startsWith('-')) {
      // deleted line — does not advance the NEW-side cursor
    } else {
      newLine++;
      valid.add(newLine);
    }
  }
  return valid;
}

export function buildValidLinesMap(files: ChangedFile[]): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of files) {
    if (f.excluded || !f.patch) continue;
    map.set(f.path, validLinesFromPatch(f.patch));
  }
  return map;
}

/**
 * Snap a reviewer-supplied line number to the nearest valid line in the diff
 * for that file. Returns `null` when the file is not part of the diff or has
 * no addressable lines — the caller re-anchors the finding to a valid diff
 * line (findings always post inline, never as top-level comments).
 */
export function snapLineToDiff(
  validLinesByFile: Map<string, Set<number>>,
  file: string,
  requestedLine: number,
): number | null {
  const valid = validLinesByFile.get(file);
  if (!valid || valid.size === 0) return null;
  if (valid.has(requestedLine)) return requestedLine;
  let best = -1;
  let bestDist = Infinity;
  for (const candidate of valid) {
    const dist = Math.abs(candidate - requestedLine);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best === -1 ? null : best;
}
