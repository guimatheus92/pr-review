import type { SkillDefinition } from '../types.js';

// Relevance heuristic: which untargeted (catalog) skills are worth force-injecting
// for THIS PR. A skill's name+description is matched against the changed file paths
// and diff text. EVERY match is injected — project rules are business knowledge a
// review must not lose, so there is deliberately no numeric cap (a repo with 38
// skills used to saturate a cap of 10 with readdir-order ties, every run). The rest
// stay in the on-demand catalog. Deterministic, no LLM, no tokens.

const MIN_TOKEN_LEN = 4; // ignore short/noise tokens
const STEM_PREFIX = 4; // shared-prefix length that counts as a match (plano↔plans, credito↔credits)
// Distinct needle matches needed to call a skill relevant. Measured on real
// 55/66-file PRs against a 47-skill corpus: business skills score 4-115, while
// non-review content (tool-internal docs, loose readmes) scores 0-2 — a bar of
// 3 cuts exactly that noise while keeping every business skill, and small PRs
// with narrow diffs still clear it via name+description stems.
const THRESHOLD = 3;

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
  const matched = relevant.map((s) => s.skill);
  const matchedSet = new Set(matched);
  const rest = catalog.filter((s) => !matchedSet.has(s));
  return { matched, rest };
}
