import type { ExistingComment, Finding } from './types.js';

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

export type DedupeMode = 'strict' | 'loose' | 'off';

export interface DedupeResult {
  kept: Finding[];
  dropped: { finding: Finding; reason: string; matchedCommentId?: string }[];
}

export function dedupeAgainstExisting(
  findings: Finding[],
  existing: ExistingComment[],
  mode: DedupeMode,
): DedupeResult {
  if (mode === 'off' || existing.length === 0) {
    return { kept: findings, dropped: [] };
  }
  const titleThreshold = mode === 'strict' ? 0.4 : 0.65;
  const bodyThreshold = mode === 'strict' ? 0.6 : 0.8;

  const kept: Finding[] = [];
  const dropped: DedupeResult['dropped'] = [];

  for (const f of findings) {
    const fileLineMatches = existing.filter((c) => {
      if (!c.file || !f.file) return false;
      if (c.file !== f.file) return false;
      if (!c.line || !f.line) return false;
      return Math.abs(c.line - f.line) <= 3;
    });

    let droppedReason: string | null = null;
    let matchedId: string | undefined;

    for (const c of fileLineMatches) {
      const titleSim = jaccard(tokenize(f.title), tokenize(c.body));
      const bodySim = jaccard(tokenize(f.body), tokenize(c.body));
      if (titleSim >= titleThreshold || bodySim >= bodyThreshold) {
        droppedReason = `overlaps existing comment (${c.author}, title-sim ${titleSim.toFixed(2)}, body-sim ${bodySim.toFixed(2)})`;
        matchedId = c.id;
        break;
      }
    }

    if (!droppedReason && mode === 'strict' && f.file && f.line) {
      const generalMatches = existing.filter(
        (c) =>
          !c.file && jaccard(tokenize(f.title), tokenize(c.body)) >= 0.5,
      );
      if (generalMatches.length > 0) {
        droppedReason = `overlaps general comment by ${generalMatches[0]!.author}`;
        matchedId = generalMatches[0]!.id;
      }
    }

    if (droppedReason) {
      dropped.push({ finding: f, reason: droppedReason, matchedCommentId: matchedId });
    } else {
      kept.push(f);
    }
  }
  return { kept, dropped };
}

export function dedupeWithinBatch(findings: Finding[]): DedupeResult {
  const kept: Finding[] = [];
  const dropped: DedupeResult['dropped'] = [];
  for (const f of findings) {
    const dup = kept.find(
      (k) =>
        k.file === f.file &&
        k.line === f.line &&
        jaccard(tokenize(k.title), tokenize(f.title)) >= 0.5,
    );
    if (dup) {
      dropped.push({ finding: f, reason: `intra-batch duplicate of "${dup.title}"` });
    } else {
      kept.push(f);
    }
  }
  return { kept, dropped };
}
