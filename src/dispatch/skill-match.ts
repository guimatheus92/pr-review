import type { SkillDefinition } from '../types.js';
import { matchesAny } from '../util/globs.js';

// Relevance heuristic: which untargeted (catalog) skills are worth force-injecting
// for THIS PR. A skill's name+description is matched against the changed file paths
// and diff text. EVERY match is injected — project rules are business knowledge a
// review must not lose, so there is deliberately no numeric cap (a repo with 38
// skills used to saturate a cap of 10 with readdir-order ties, every run). The rest
// stay in the on-demand catalog. Deterministic, no LLM, no tokens.

const MIN_TOKEN_LEN = 4; // ignore short/noise tokens
const STEM_PREFIX = 4; // shared-prefix length that counts as a match (plano↔plans, credito↔credits)
// Distinct needle matches needed to call a skill relevant. Measured on real
// 55/66-file PRs against a 47-skill corpus: with a bar of 1 every skill matched
// (47/47 — "relevant" meant nothing on a large diff); at 3, richly-described
// business skills (scoring 4-115 there) all pass while most low-signal loose
// files drop. The bar adapts down for terse skills: a skill whose name +
// description yield fewer needles than THRESHOLD only needs to hit all of
// them — otherwise short metadata would be structurally unmatchable.
const THRESHOLD = 3;

// Small pt+en stopword set — words too common to signal a topic. Not exhaustive by
// design: over-filtering costs recall, and the on-demand catalog absorbs the noise.
const STOPWORDS = new Set([
  // pt
  'para', 'pela', 'pelo', 'este', 'esta', 'esse', 'essa', 'isso', 'como', 'quando', 'sempre',
  'todo', 'toda', 'todos', 'todas', 'regra', 'regras', 'sobre', 'consultar', 'usar', 'deve',
  'devem', 'ferramenta', 'projeto', 'arquivo', 'arquivos',
  // en
  'this', 'that', 'these', 'those', 'with', 'from', 'when', 'always', 'rule', 'rules', 'about',
  'skill', 'skills', 'use', 'used', 'using', 'must', 'should', 'file', 'files', 'project', 'code',
  'guide', 'guidelines', 'reference', 'review', 'reviews',
]);

/** lowercase + strip diacritics so pt "crédito" folds toward en "credit". */
function fold(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

function tokenize(s: string): string[] {
  return fold(s.replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

function identityTokens(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !PLUGIN_NOISE.has(token));
}

const PLUGIN_NOISE = new Set([
  ...STOPWORDS,
  'create', 'modify', 'manage', 'workflow', 'solution', 'developer', 'installed',
  'generic', 'existing', 'changes', 'change', 'authoring', 'collection', 'docs',
  'plugin', 'plugins', 'suite', 'toolkit', 'tools',
]);
const REVIEW_INTENT = new Set(['review', 'reviewer', 'audit', 'validate', 'validation', 'testing', 'security', 'quality', 'knowledge']);
const REVIEW_ACTIVATION = new Set(['review', 'reviewer', 'audit', 'knowledge', 'investigate', 'investigation', 'analyze', 'analysis']);

export interface PluginSkillMatch {
  skill: SkillDefinition;
  matchedOn: string[];
  score: number;
}

/**
 * Installed plugins are selected from evidence, not a technology table. A
 * direct appliesTo match wins. Otherwise two exact topic tokens are required,
 * except an exact repository-name match, which is strong enough on its own.
 */
export function selectRelevantPluginSkills(
  skills: SkillDefinition[],
  inScopeFiles: { path: string }[],
  context: { repoName: string; stackTags: string[]; title?: string },
): { matched: PluginSkillMatch[]; rest: SkillDefinition[] } {
  const evidence = new Set(
    tokenize([
      context.repoName,
      context.title ?? '',
      ...context.stackTags,
      ...inScopeFiles.map((file) => file.path),
    ].join(' ')),
  );
  const repoTokens = new Set(tokenize(context.repoName));
  const identityEvidence = new Set(identityTokens([
    context.repoName,
    context.title ?? '',
    ...inScopeFiles.map((file) => file.path),
  ].join(' ')));
  const matched: PluginSkillMatch[] = [];
  const rest: SkillDefinition[] = [];
  for (const skill of skills) {
    const globHits = skill.appliesTo.filter((glob) => inScopeFiles.some((file) => matchesAny(file.path, [glob])));
    const topics = new Set(
      tokenize(`${skill.name} ${skill.description ?? ''}`)
        .filter((token) => !PLUGIN_NOISE.has(token)),
    );
    const topicHits = [...topics].filter((token) => evidence.has(token)).sort();
    const repoHit = repoTokens.size > 0 && [...repoTokens].every((token) => topics.has(token));
    const pluginTokens = identityTokens(skill.plugin ?? '');
    const pluginHit = pluginTokens.length > 0 && pluginTokens.every((token) => identityEvidence.has(token));
    const reviewActivation = tokenize(skill.name).some((token) => REVIEW_ACTIVATION.has(token));
    if (globHits.length === 0 && (!(repoHit && reviewActivation) && (!pluginHit || topicHits.length < 2))) {
      rest.push(skill);
      continue;
    }
    const intent = [...topics].filter((token) => REVIEW_INTENT.has(token)).length;
    matched.push({
      skill,
      matchedOn: globHits.length > 0 ? globHits : topicHits,
      score: globHits.length * 100 + topicHits.length * 10 + intent * 20 + (repoHit ? 25 : 0) + (reviewActivation ? 50 : 0),
    });
  }
  matched.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  return { matched, rest };
}

/** Split the catalog into skills relevant to the changed files (matched) and the rest. */
export function selectRelevantSkills(
  catalog: SkillDefinition[],
  inScopeFiles: { path: string; patch?: string }[],
): { matched: SkillDefinition[]; rest: SkillDefinition[] } {
  // Haystack of distinct prefixes from every changed path + diff hunk. Keying by the
  // first STEM_PREFIX chars lets an inflected/translated needle hit via a shared stem.
  const haystackPrefixes = new Set<string>();
  for (const f of inScopeFiles) {
    for (const tok of [...tokenize(f.path), ...tokenize(f.patch ?? '')]) {
      haystackPrefixes.add(tok.slice(0, STEM_PREFIX));
    }
  }

  const scored = catalog.map((skill) => {
    const needles = new Set(
      tokenize(`${skill.name} ${skill.description ?? ''}`).filter((t) => !STOPWORDS.has(t)),
    );
    let score = 0;
    for (const n of needles) if (haystackPrefixes.has(n.slice(0, STEM_PREFIX))) score++;
    // Terse metadata lowers the bar to what the skill can actually score.
    const bar = Math.max(1, Math.min(THRESHOLD, needles.size));
    return { skill, score, bar };
  });

  const relevant = scored
    .filter((s) => s.score >= s.bar)
    .sort((a, b) => b.score - a.score);
  const matched = relevant.map((s) => s.skill);
  const matchedSet = new Set(matched);
  const rest = catalog.filter((s) => !matchedSet.has(s));
  return { matched, rest };
}
