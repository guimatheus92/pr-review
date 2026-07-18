import type { SkillDefinition } from '../types.js';

// Relevance heuristic: which untargeted (catalog) skills are worth force-injecting
// for THIS PR. A skill's name+description is matched against the changed file paths
// and diff text. Matches are injected (shown as "Injected: N"); the rest stay in the
// on-demand catalog. Deterministic, no LLM, no tokens — a false negative just falls
// back to the catalog, and a false positive costs one extra (capped) skill body.

const MIN_TOKEN_LEN = 4; // ignore short/noise tokens
const STEM_PREFIX = 4; // shared-prefix length that counts as a match (plano↔plans, credito↔credits)
const THRESHOLD = 1; // distinct needle matches needed to call a skill relevant
export const MAX_HEURISTIC_INJECT = 10; // cap injected count; overflow → catalog (token budget)

// Small pt+en stopword set — words too common to signal a topic. Not exhaustive by
// design: over-filtering costs recall, and the cap+catalog absorb the noise.
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
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
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
    return { skill, score };
  });

  const relevant = scored
    .filter((s) => s.score >= THRESHOLD)
    .sort((a, b) => b.score - a.score);
  const matched = relevant.slice(0, MAX_HEURISTIC_INJECT).map((s) => s.skill);
  const matchedSet = new Set(matched);
  const rest = catalog.filter((s) => !matchedSet.has(s));
  return { matched, rest };
}
