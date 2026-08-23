import type { SkillDefinition } from '../types.js';
import { matchesAny } from '../util/globs.js';
import { selectRelevantSkills } from './skill-match.js';

/**
 * Deterministic selection of the review passes for one PR. There are no
 * built-in reviewers: every pass IS a skill — from the synced packs, the
 * repo's own skill dirs, or forced dirs — dispatched to a generic agent.
 */

export const MAX_PASSES = 10;

export type MatchedBy = 'glob' | 'tag' | 'repo' | 'forced' | 'baseline';

export interface ReviewPass {
  /** `<pack>/<skill>` for pack skills; the plain skill name otherwise. Unique. */
  name: string;
  source: string;
  body: string;
  description?: string;
  matchedBy: MatchedBy;
  /** What hit: the matching globs (glob) or stack tags (tag); [] for repo/forced/baseline. */
  matchedOn: string[];
}

export interface IndexEntry {
  name: string;
  description: string;
  source: string;
  tags: string[];
  pack?: string;
}

/** One row per known skill — dispatched, indexed, or skipped — for the summary and --resume. */
export interface PassRoute {
  name: string;
  source: string;
  matchedBy: MatchedBy | 'index' | 'skipped';
}

export interface PassSelection {
  /** Ordered glob > tag > repo > forced > baseline, capped at MAX_PASSES. */
  passes: ReviewPass[];
  /** Overflow first, then stack-relevant entries, then the rest (incl. index-only packs). */
  indexEntries: IndexEntry[];
  stackTags: string[];
  routes: PassRoute[];
  /** Baseline pointers whose skill did not load — renamed upstream or pack missing. */
  missingBaseline: string[];
}

const RANK: Record<MatchedBy, number> = { glob: 0, tag: 1, repo: 2, forced: 3, baseline: 4 };

/** A match-everything glob is not stack-specific — it never counts as a glob hit. */
function isMatchAll(g: string): boolean {
  return g === '**' || g === '*' || g === '**/*';
}

const DESC_CAP = 200;

/**
 * Tokens a skill offers for EXACT stack-tag matching: its name (sans pack
 * prefix), source basename, and frontmatter tags. Exact, not the 4-char-prefix
 * heuristic of skill-match.ts: that heuristic serves a huge haystack (the
 * diff) where recall wins; here ~600 pack skills meet ~10-40 stack tags, and
 * prefixes would flood the cap (`java`→`javascript`, `test`→`testing`). The
 * index absorbs false negatives.
 */
function tokensOf(s: SkillDefinition): Set<string> {
  const nameNoPack = s.pack && s.name.startsWith(`${s.pack}/`) ? s.name.slice(s.pack.length + 1) : s.name;
  const base = s.source.replace(/\\/g, '/').split('/').pop() ?? '';
  const raw = `${nameNoPack} ${base} ${(s.tags ?? []).join(' ')}`.toLowerCase();
  return new Set(raw.split(/[^a-z0-9#+]+/).filter((t) => t.length >= 2));
}

function toIndexEntry(s: SkillDefinition): IndexEntry {
  return {
    name: s.name,
    description: (s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, DESC_CAP),
    source: s.source,
    tags: s.tags ?? [],
    pack: s.pack,
  };
}

interface Candidate {
  pass: ReviewPass;
  skill: SkillDefinition;
}

function candidate(s: SkillDefinition, matchedBy: MatchedBy, matchedOn: string[]): Candidate {
  return {
    skill: s,
    pass: { name: s.name, source: s.source, body: s.body, description: s.description, matchedBy, matchedOn },
  };
}

export function selectPasses(input: {
  /** Loader `skills`: targeted repo/home/plugin skills + forced dirs. */
  skills: SkillDefinition[];
  /** Loader `catalog`: untargeted repo skills (relevance heuristic applies). */
  catalog: SkillDefinition[];
  /** Loader `packSkills`. */
  packSkills: SkillDefinition[];
  inScopeFiles: { path: string; patch?: string }[];
  stackTags: string[];
  /** Fully-qualified `<pack>/<skill>` names that run on every PR. */
  baseline: string[];
}): PassSelection {
  const stackSet = new Set(input.stackTags.map((t) => t.toLowerCase()));
  const inScopePaths = input.inScopeFiles.map((f) => f.path);
  const baselineSet = new Set(input.baseline);
  const candidates: Candidate[] = [];
  const indexSkills: SkillDefinition[] = [];

  for (const s of input.packSkills) {
    if (s.mode === 'index') {
      indexSkills.push(s);
      continue;
    }
    const globs = s.appliesTo.filter((g) => !isMatchAll(g));
    const globHits = globs.filter((g) => inScopePaths.some((p) => matchesAny(p, [g])));
    if (globHits.length > 0) {
      candidates.push(candidate(s, 'glob', globHits));
      continue;
    }
    const tagHits = [...tokensOf(s)].filter((t) => stackSet.has(t)).sort();
    if (tagHits.length > 0) {
      candidates.push(candidate(s, 'tag', tagHits));
      continue;
    }
    if (baselineSet.has(s.name)) {
      candidates.push(candidate(s, 'baseline', []));
      continue;
    }
    indexSkills.push(s);
  }

  for (const s of input.skills) {
    if (s.origin === 'forced') {
      candidates.push(candidate(s, 'forced', []));
      continue;
    }
    // Today's targeted-skill semantics: empty applies_to = always applies.
    if (s.appliesTo.length === 0) {
      candidates.push(candidate(s, 'glob', []));
    } else {
      const hits = s.appliesTo.filter((g) => inScopePaths.some((p) => matchesAny(p, [g])));
      if (hits.length > 0) candidates.push(candidate(s, 'glob', hits));
      else indexSkills.push(s);
    }
  }

  const { matched, rest } = selectRelevantSkills(input.catalog, input.inScopeFiles);
  for (const s of matched) candidates.push(candidate(s, 'repo', []));
  indexSkills.push(...rest);

  const ordered = [...candidates].sort(
    (a, b) =>
      RANK[a.pass.matchedBy] - RANK[b.pass.matchedBy] ||
      b.pass.matchedOn.length - a.pass.matchedOn.length ||
      a.pass.name.localeCompare(b.pass.name),
  );
  // One pass per name; a baseline pointer that also glob/tag-matched keeps its higher tier.
  const seen = new Set<string>();
  const deduped: Candidate[] = [];
  for (const c of ordered) {
    if (seen.has(c.pass.name)) continue;
    seen.add(c.pass.name);
    deduped.push(c);
  }
  const kept = deduped.slice(0, MAX_PASSES);
  const overflow = deduped.slice(MAX_PASSES);

  // Index order: overflow (most specific first), then stack-relevant, then the rest.
  const scored = indexSkills
    .map((s) => ({ s, score: [...tokensOf(s)].filter((t) => stackSet.has(t)).length }))
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  const indexEntries = [
    ...overflow.map((c) => toIndexEntry(c.skill)),
    ...scored.map(({ s }) => toIndexEntry(s)),
  ];

  const passes = kept.map((c) => c.pass);
  const routes: PassRoute[] = [
    ...passes.map((p) => ({ name: p.name, source: p.source, matchedBy: p.matchedBy as PassRoute['matchedBy'] })),
    ...indexEntries.map((e) => ({ name: e.name, source: e.source, matchedBy: 'index' as const })),
  ];

  const packNames = new Set(input.packSkills.map((s) => s.name));
  const missingBaseline = input.baseline.filter((b) => !packNames.has(b));

  return { passes, indexEntries, stackTags: [...stackSet].sort(), routes, missingBaseline };
}
