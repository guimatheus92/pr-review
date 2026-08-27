import type { SkillDefinition } from '../types.js';
import { matchesAny } from '../util/globs.js';
import { selectRelevantPluginSkills, selectRelevantSkills } from './skill-match.js';

/**
 * Deterministic selection of the review passes for one PR. There are no
 * built-in reviewers: every pass IS a skill — from the synced packs, the
 * repo's own skill dirs, or forced dirs — dispatched to a generic agent.
 */

/** Cap on stack-matched (glob/tag) pack passes. Baselines ride on top — they are
 *  the generic lenses that must run on every code PR (observed live: a repo with
 *  47 project skills otherwise starved security/baseline coverage entirely). */
export const MAX_STACK_PASSES = 6;
export const MAX_PLUGIN_PASSES = 2;
/** Fallback cap when project skills ARE the passes (no packs configured). */
export const MAX_PASSES = 10;

export type MatchedBy = 'glob' | 'dependency' | 'tag' | 'plugin' | 'repo' | 'forced' | 'baseline';

export interface ReviewPass {
  /** `<pack>/<skill>` for pack skills; the plain skill name otherwise. Unique. */
  name: string;
  source: string;
  body: string;
  description?: string;
  matchedBy: MatchedBy;
  /** What hit: the matching globs (glob) or stack tags (tag); [] for repo/forced/baseline. */
  matchedOn: string[];
  /** Where the skill came from — project-origin pass bodies are never truncated; 'pack' bodies cap. */
  origin?: SkillDefinition['origin'];
  /** Configured baseline membership, independent of the strongest match reason displayed in routing. */
  baseline?: boolean;
  plugin?: string;
  mcpServers?: string[];
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

/** Generic dependency manifests identify an ecosystem, not a specific product or framework. */
function isManifestGlob(g: string): boolean {
  return /(^|\/)(package\.json|manifest\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|gemfile|pom\.xml|composer\.json)$/i.test(g);
}

/** `*agent*` / `*plugin*` path fragments are keyword search, not proof of a product. */
function isKeywordGlob(g: string): boolean {
  return /\*[a-z0-9_-]+\*/i.test(g);
}

/** Expand simple brace alternatives for evidence classification; matching still uses the normal glob engine. */
function expandBraceAlternatives(glob: string): string[] {
  const match = glob.match(/\{([^{}]+)\}/);
  if (!match) return [glob];
  return match[1]!.split(',').flatMap((part) =>
    expandBraceAlternatives(glob.slice(0, match.index) + part.trim() + glob.slice((match.index ?? 0) + match[0].length)),
  );
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
  const filename = s.source.replace(/\\/g, '/').split('/').pop() ?? '';
  const base = /^SKILL\.md$/i.test(filename) ? '' : filename.replace(/(\.instructions)?\.md$/i, '');
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
  priority: number;
}

const MATCH_PRIORITY = {
  specificGlob: 0,
  dependency: 1,
  languageGlob: 2,
  tag: 3,
  other: 4,
} as const;

function candidate(
  s: SkillDefinition,
  matchedBy: MatchedBy,
  matchedOn: string[],
  priority: number = MATCH_PRIORITY.other,
): Candidate {
  return {
    skill: s,
    priority,
    pass: {
      name: s.name,
      source: s.source,
      body: s.body,
      description: s.description,
      matchedBy,
      matchedOn,
      origin: s.origin,
      plugin: s.plugin,
      mcpServers: s.mcpServers,
    },
  };
}

const GENERIC_IDENTITY_TOKENS = new Set([
  'application', 'applications', 'architecture', 'best', 'code', 'design', 'development',
  'framework', 'good', 'guide', 'guidelines', 'instruction', 'instructions', 'pattern',
  'js', 'patterns', 'practice', 'practices', 'review', 'reviews', 'sdk', 'security', 'server',
]);

export function selectPasses(input: {
  /** Loader `skills`: targeted repo/home/plugin skills + forced dirs. */
  skills: SkillDefinition[];
  /** Loader `catalog`: untargeted repo skills (relevance heuristic applies). */
  catalog: SkillDefinition[];
  /** Loader `packSkills`. */
  packSkills: SkillDefinition[];
  /** Skills supplied by installed Copilot/Claude plugins. */
  installedPluginSkills?: SkillDefinition[];
  inScopeFiles: { path: string; patch?: string }[];
  stackTags: string[];
  /** Categorized evidence from stack detection. Omitted by legacy/test callers. */
  stackEvidence?: {
    languages: string[];
    ecosystems: string[];
    dependencies: string[];
    dependencyTokens: string[];
    dependencyGroups?: { dependency: string; tokens: string[] }[];
  };
  /** Fully-qualified `<pack>/<skill>` names that run on every PR. */
  baseline: string[];
  reviewContext?: { repoName: string; title?: string };
}): PassSelection {
  const stackSet = new Set(input.stackTags.map((t) => t.toLowerCase()));
  const languageSet = new Set(
    (input.stackEvidence ? [...input.stackEvidence.languages, ...input.stackEvidence.ecosystems] : input.stackTags)
      .map((tag) => tag.toLowerCase()),
  );
  const dependencySet = new Set(
    [...(input.stackEvidence?.dependencies ?? []), ...(input.stackEvidence?.dependencyTokens ?? [])]
      .map((tag) => tag.toLowerCase()),
  );
  const dependencyGroups = input.stackEvidence?.dependencyGroups?.map(
    (group) => new Set([group.dependency, ...group.tokens].map((token) => token.toLowerCase())),
  );
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
    const globHits = [
      ...new Set(
        globs.flatMap((glob) =>
          expandBraceAlternatives(glob).filter((pattern) => inScopePaths.some((path) => matchesAny(path, [pattern]))),
        ),
      ),
    ];
    const identityTokens = [...tokensOf(s)];
    const tagHits = identityTokens.filter((t) => stackSet.has(t)).sort();
    const languageHits = identityTokens.filter((t) => languageSet.has(t)).sort();
    const specificIdentityTokens = identityTokens.filter(
      (token) => !languageSet.has(token) && !GENERIC_IDENTITY_TOKENS.has(token),
    );
    const dependencyBacked = specificIdentityTokens.length > 0 && (
      dependencyGroups
        ? dependencyGroups.some((group) => specificIdentityTokens.every((token) => group.has(token)))
        : specificIdentityTokens.every((token) => dependencySet.has(token))
    );
    const specificHits = globHits.filter((g) => !isLanguageGlob(g) && !isManifestGlob(g) && !isKeywordGlob(g));
    if (specificHits.length > 0) {
      // A filename / directory / compound glob is real targeting on its own.
      candidates.push(candidate(s, 'glob', specificHits, MATCH_PRIORITY.specificGlob));
      continue;
    }
    if (dependencyBacked) {
      candidates.push(candidate(s, 'dependency', [...specificIdentityTokens.sort(), ...globHits], MATCH_PRIORITY.dependency));
      continue;
    }
    const identityIsLanguageGeneric = !input.stackEvidence || specificIdentityTokens.length === 0;
    if (globHits.length > 0 && languageHits.length > 0 && identityIsLanguageGeneric) {
      // Type-only and generic-manifest globs count only for a language-generic skill or one backed by a dependency above.
      candidates.push(candidate(s, 'glob', [...languageHits, ...globHits], MATCH_PRIORITY.languageGlob));
      continue;
    }
    if (tagHits.length > 0 && identityIsLanguageGeneric) {
      candidates.push(candidate(s, 'tag', tagHits, MATCH_PRIORITY.tag));
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
    .filter((c) => c.pass.matchedBy === 'glob' || c.pass.matchedBy === 'dependency' || c.pass.matchedBy === 'tag')
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        b.pass.matchedOn.length - a.pass.matchedOn.length ||
        a.pass.name.localeCompare(b.pass.name),
    );
  const stackKept = stackCandidates.slice(0, MAX_STACK_PASSES);
  const stackOverflow = stackCandidates.slice(MAX_STACK_PASSES);

  const pluginSelection = selectRelevantPluginSkills(
    input.installedPluginSkills ?? [],
    input.inScopeFiles,
    {
      repoName: input.reviewContext?.repoName ?? '',
      title: input.reviewContext?.title,
      stackTags: input.stackEvidence
        ? [...input.stackEvidence.languages, ...input.stackEvidence.ecosystems]
        : [...stackSet],
    },
  );
  const pluginKept = pluginSelection.matched.slice(0, MAX_PLUGIN_PASSES).map((match) =>
    candidate(match.skill, 'plugin', match.matchedOn, MATCH_PRIORITY.tag),
  );
  const pluginOverflow = pluginSelection.matched.slice(MAX_PLUGIN_PASSES).map((match) => match.skill);

  // Baselines ALWAYS dispatch — they are the generic lenses of every code
  // review. Two sources: pointers that matched nothing else, and pointers that
  // stack-matched but LOST the stack cap (without re-adding those, a baseline
  // that also glob-matched would be silently evicted — dogfood finding).
  const keptNames = new Set(stackKept.map((c) => c.pass.name));
  const evictedBaselines = stackOverflow
    .filter((c) => baselineSet.has(c.pass.name))
    .map((c) => candidate(c.skill, 'baseline', []));
  const baselines = [
    ...candidates.filter((c) => c.pass.matchedBy === 'baseline' && !keptNames.has(c.pass.name)),
    ...evictedBaselines,
  ];

  let kept = [...stackKept, ...pluginKept, ...baselines];
  let projectSkills = project.map((c) => c.skill);
  let projectRoutes: PassRoute[] = project.map((c) => ({
    name: c.pass.name,
    source: c.pass.source,
    matchedBy: 'context' as const,
  }));

  // Fallback: with no pack passes at all (skill_packs: [] or nothing matched),
  // the project skills ARE the review — each runs as its own pass. Overflow
  // beyond the pass cap stays CONTEXT (injected whole into every pass), never
  // the index: the no-rule-lost guarantee holds in this mode too.
  if (kept.length === 0 && project.length > 0) {
    kept = project.slice(0, MAX_PASSES);
    const overflow = project.slice(MAX_PASSES);
    projectSkills = overflow.map((c) => c.skill);
    projectRoutes = overflow.map((c) => ({ name: c.pass.name, source: c.pass.source, matchedBy: 'context' as const }));
  }

  // Index order: overflow (most specific first), then stack-relevant, then the rest.
  const scored = indexSkills
    .map((s) => ({ s, score: [...tokensOf(s)].filter((t) => stackSet.has(t)).length }))
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  const indexEntries = [
    // Overflowed baselines still dispatch as baseline passes — don't double-list them.
    ...stackOverflow.filter((c) => !baselineSet.has(c.pass.name)).map((c) => toIndexEntry(c.skill)),
    ...pluginOverflow.map(toIndexEntry),
    ...pluginSelection.rest.map(toIndexEntry),
    ...scored.map(({ s }) => toIndexEntry(s)),
  ];

  const passes = kept.map((c) => ({ ...c.pass, baseline: baselineSet.has(c.pass.name) }));
  const routes: PassRoute[] = [
    ...passes.map((p) => ({ name: p.name, source: p.source, matchedBy: p.matchedBy as PassRoute['matchedBy'] })),
    ...projectRoutes,
    ...indexEntries.map((e) => ({ name: e.name, source: e.source, matchedBy: 'index' as const })),
  ];

  // A pointer into an index-mode pack can never dispatch — that is "missing" too.
  const eligible = new Set(input.packSkills.filter((s) => s.mode !== 'index').map((s) => s.name));
  const missingBaseline = input.baseline.filter((b) => !eligible.has(b));

  return { passes, projectSkills, indexEntries, stackTags: [...stackSet].sort(), routes, missingBaseline };
}
