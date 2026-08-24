import type { SkillDefinition } from '../types.js';
import { matchesAny } from '../util/globs.js';
import { selectRelevantSkills } from './skill-match.js';

/**
 * Deterministic selection of the review passes for one PR. There are no
 * built-in reviewers: every pass IS a skill — from the synced packs, the
 * repo's own skill dirs, or forced dirs — dispatched to a generic agent.
 */

/** Cap on stack-matched (glob/tag) pack passes. Baselines ride on top — they are
 *  the generic lenses that must run on every code PR (observed live: a repo with
 *  47 project skills otherwise starved security/baseline coverage entirely). */
export const MAX_STACK_PASSES = 6;
/** Fallback cap when project skills ARE the passes (no packs configured). */
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

/** One row per known skill — dispatched, project context, indexed, or skipped. */
export interface PassRoute {
  name: string;
  source: string;
  matchedBy: MatchedBy | 'context' | 'index' | 'skipped';
}

export interface PassSelection {
  /** Stack passes (pack glob/tag, capped) + every baseline. With no packs, the project skills. */
  passes: ReviewPass[];
  /**
   * The user's own matched skills: NOT individual passes — authoritative
   * context injected into EVERY pass (the product's original core value:
   * project rules override generic judgement). Empty when they became the
   * passes themselves (fallback with no packs).
   */
  projectSkills: SkillDefinition[];
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
  // `**/*.ts`, `**.ts`, `*.md` — and the brace form `**/*.{ts,tsx,js,json}`
  // (pcf-*/aws-appsync in awesome-copilot), which is still type-only matching.
  return /^(\*\*\/)?\*{1,2}\.(\{[\w ,.-]+\}|[a-z0-9_-]+)$/i.test(g);
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

  // The user's own skills are CONTEXT, not lenses: they carry the business
  // rules every pass must apply, so they inject into all passes instead of
  // consuming pass slots 1:1 (a repo with 47 skills used to starve every
  // baseline/stack pass out of the cap). They keep a matchedBy label for the
  // routing table.
  const project: Candidate[] = [];
  for (const s of input.skills) {
    if (s.origin === 'forced') {
      project.push(candidate(s, 'forced', []));
      continue;
    }
    // Targeted-skill semantics: empty applies_to = always applies.
    if (s.appliesTo.length === 0) {
      project.push(candidate(s, 'glob', []));
    } else {
      const hits = s.appliesTo.filter((g) => inScopePaths.some((p) => matchesAny(p, [g])));
      if (hits.length > 0) project.push(candidate(s, 'glob', hits));
      else indexSkills.push(s);
    }
  }

  const { matched, rest } = selectRelevantSkills(input.catalog, input.inScopeFiles);
  for (const s of matched) project.push(candidate(s, 'repo', []));
  indexSkills.push(...rest);

  // Stack passes: pack glob/tag hits, most specific first, capped.
  const stackCandidates = candidates
    .filter((c) => c.pass.matchedBy === 'glob' || c.pass.matchedBy === 'tag')
    .sort(
      (a, b) =>
        (a.pass.matchedBy === 'glob' ? 0 : 1) - (b.pass.matchedBy === 'glob' ? 0 : 1) ||
        b.pass.matchedOn.length - a.pass.matchedOn.length ||
        a.pass.name.localeCompare(b.pass.name),
    );
  const stackKept = stackCandidates.slice(0, MAX_STACK_PASSES);
  const stackOverflow = stackCandidates.slice(MAX_STACK_PASSES);

  // Baselines ALWAYS dispatch (deduped against a baseline that already
  // stack-matched) — they are the generic lenses of every code review.
  const keptNames = new Set(stackKept.map((c) => c.pass.name));
  const baselines = candidates.filter(
    (c) => c.pass.matchedBy === 'baseline' && !keptNames.has(c.pass.name),
  );

  let kept = [...stackKept, ...baselines];
  let projectSkills = project.map((c) => c.skill);
  let projectRoutes: PassRoute[] = project.map((c) => ({
    name: c.pass.name,
    source: c.pass.source,
    matchedBy: 'context' as const,
  }));

  // Fallback: with no pack passes at all (skill_packs: [] or nothing matched),
  // the project skills ARE the review — each runs as its own pass, as before.
  if (kept.length === 0 && project.length > 0) {
    kept = project.slice(0, MAX_PASSES);
    for (const c of project.slice(MAX_PASSES)) indexSkills.push(c.skill);
    projectSkills = [];
    projectRoutes = [];
  }

  // Index order: overflow (most specific first), then stack-relevant, then the rest.
  const scored = indexSkills
    .map((s) => ({ s, score: [...tokensOf(s)].filter((t) => stackSet.has(t)).length }))
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  const indexEntries = [
    ...stackOverflow.map((c) => toIndexEntry(c.skill)),
    ...scored.map(({ s }) => toIndexEntry(s)),
  ];

  const passes = kept.map((c) => c.pass);
  const routes: PassRoute[] = [
    ...passes.map((p) => ({ name: p.name, source: p.source, matchedBy: p.matchedBy as PassRoute['matchedBy'] })),
    ...projectRoutes,
    ...indexEntries.map((e) => ({ name: e.name, source: e.source, matchedBy: 'index' as const })),
  ];

  const packNames = new Set(input.packSkills.map((s) => s.name));
  const missingBaseline = input.baseline.filter((b) => !packNames.has(b));

  return { passes, projectSkills, indexEntries, stackTags: [...stackSet].sort(), routes, missingBaseline };
}
