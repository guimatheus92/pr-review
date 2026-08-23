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
  /** Ranked forced > repo (user content) > pack glob > pack tag > baseline, capped at MAX_PASSES. */
  passes: ReviewPass[];
  /** Overflow first, then stack-relevant entries, then the rest (incl. index-only packs). */
  indexEntries: IndexEntry[];
  stackTags: string[];
  routes: PassRoute[];
  /** Baseline pointers whose skill did not load — renamed upstream or pack missing. */
  missingBaseline: string[];
}

/** A match-everything glob is not stack-specific — it never counts as a glob hit. */
function isMatchAll(g: string): boolean {
  return g === '**' || g === '*' || g === '**/*';
}

/**
 * A bare extension wildcard (`**​/*.ts`, `**.json`, `*.md`) matches by file TYPE
 * alone. Pack authors use these promiscuously — awesome-copilot's astro/nestjs/
 * svelte/wordpress guides all claim `**​/*.ts` — so for PACK skills a
 * language-glob hit only counts when the skill's own identity (name/tags) also
 * overlaps the stack. Observed live: without this, a TypeScript PR filled all
 * 10 slots with framework guides for frameworks the repo doesn't use.
 */
function isLanguageGlob(g: string): boolean {
  return /^(\*\*\/)?\*{1,2}\.[a-z0-9_-]+$/i.test(g);
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
  // The file's own .md extension (and the pack-format .instructions suffix) is
  // container format, not identity — without stripping it, every pack file
  // "matches" any PR that touches markdown (stack tag `md`).
  const base = (s.source.replace(/\\/g, '/').split('/').pop() ?? '').replace(/(\.instructions)?\.md$/i, '');
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
    const tagHits = [...tokensOf(s)].filter((t) => stackSet.has(t)).sort();
    const specificHits = globHits.filter((g) => !isLanguageGlob(g));
    if (specificHits.length > 0) {
      // A filename / directory / compound glob is real targeting on its own.
      candidates.push(candidate(s, 'glob', specificHits));
      continue;
    }
    if (globHits.length > 0 && tagHits.length > 0) {
      // Extension-only globs count only for a stack-consistent skill.
      candidates.push(candidate(s, 'glob', [...tagHits, ...globHits]));
      continue;
    }
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

  // The user's own content outranks any pack: repo/plugin skills carry the
  // business rules this tool exists to apply (forced dirs are the most explicit
  // opt-in of all). Packs fill the remaining slots; baseline fills last.
  const rankOf = (c: Candidate): number => {
    if (c.pass.matchedBy === 'forced') return 0;
    if (c.skill.origin !== 'pack' && (c.pass.matchedBy === 'glob' || c.pass.matchedBy === 'repo')) return 1;
    if (c.pass.matchedBy === 'glob') return 2;
    if (c.pass.matchedBy === 'tag') return 3;
    return 4; // baseline
  };
  const ordered = [...candidates].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
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
