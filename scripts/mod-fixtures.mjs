#!/usr/bin/env node
// Regenerate the live mod's test fixture from a real run directory.
//
//   node scripts/mod-fixtures.mjs <run-dir> mods/live/tests/fixtures/run-798.ts
//
// The mod test kit (`claude plugin test`) has no file access, so the run dir is shipped
// as a TypeScript module exporting two file-name -> content maps:
//   DONE    — the run as it finished: the feeds and state verbatim, the plan with prompts
//             elided and its artifact list trimmed, passes.json without the on-demand
//             index rows beyond three.
//   RUNNING — the same run cut at a point in time T during the initial batch (just after
//             the 7th reviewer's output was first seen): feed lines with ts <= T, and
//             delivery-state.json in the in-flight shape single-session.ts writes while
//             the batch runs (kind running, status started, nothing valid yet).
//
// The SHAPES are the real ones; the IDENTITY is not. The fixture lands in a public repo,
// and the mod reads only pr.owner/repo/number, each reviewer's name/kind/source/matchedBy/
// maxAttempts, the codex/verifier flags and the passes.json rows — so everything else that
// names the reviewed repository is folded to neutral values: owner/repo, run id, branches,
// SHAs, the checkout path, every project rule's name and path, installed plugins and MCP
// servers, and the reviewer's home directory. Pack and companion names are public. The
// output is refused when any original identifier survives.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const [runDir, outFile] = process.argv.slice(2);
if (!runDir || !outFile) {
  console.error('usage: node scripts/mod-fixtures.mjs <run-dir> <out-file.ts>');
  process.exit(2);
}

const ORIGINAL_RUN = basename(runDir);
const HOME = homedir();
const WIN = HOME.includes('\\');
const NEUTRAL_HOME = WIN ? 'C:\\Users\\dev' : '/home/dev';
const OWNER = 'acme';
const REPO = 'backend';
const CHECKOUT = WIN ? 'C:/Users/dev/repos/backend' : '/home/dev/repos/backend';
const SEP = WIN ? '\\' : '/';

const rawPlan = JSON.parse(readFileSync(join(runDir, 'dispatch-plan.json'), 'utf8'));
const originalOwner = rawPlan.pr.owner;
const originalRepo = rawPlan.pr.repo;
const originalRoot = rawPlan.repoRoot ? rawPlan.repoRoot.replace(/\\/g, '/') : null;
const idParts = ORIGINAL_RUN.split('__');
const RUN = [idParts[0], OWNER, REPO, idParts[3], idParts[4]].join('__');
const RUN_DIR = NEUTRAL_HOME + SEP + '.pr-review' + SEP + 'runs' + SEP + RUN;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Replace every spelling of `from` (plain, JSON-escaped backslashes, forward slashes). */
function replaceAll(text, from, to) {
  const forms = new Set([from, from.replace(/\\/g, '/'), JSON.stringify(from).slice(1, -1)]);
  let out = text;
  for (const f of forms) {
    if (!f) continue;
    const t = f === from ? to : f.includes('\\\\') ? JSON.stringify(to).slice(1, -1) : to.replace(/\\/g, '/');
    out = out.replace(new RegExp(escapeRe(f), 'g'), t);
  }
  return out;
}
function fold(text) {
  let out = replaceAll(text, HOME, NEUTRAL_HOME);
  out = replaceAll(out, ORIGINAL_RUN, RUN);
  out = out.replace(new RegExp(escapeRe(originalOwner) + '/' + escapeRe(originalRepo), 'g'), OWNER + '/' + REPO);
  out = out.replace(new RegExp('"owner":"' + escapeRe(originalOwner) + '"', 'g'), '"owner":"' + OWNER + '"');
  out = out.replace(new RegExp('"repo":"' + escapeRe(originalRepo) + '"', 'g'), '"repo":"' + REPO + '"');
  return out;
}
const read = (f) => fold(readFileSync(join(runDir, f), 'utf8'));

const done = {};
for (const f of ['progress.ndjson', 'reviewer-progress.ndjson', 'delivery-state.json', 'finalization.json', 'run.pid']) {
  done[f] = read(f);
}

// passes.json: the dispatched rows keep their (public) pack names; every project rule and
// every on-demand row is renamed, because their names and paths describe the reviewed repo.
const passes = JSON.parse(read('passes.json'));
let rule = 0;
let index = 0;
const kept = [];
for (const row of passes) {
  if (row.matchedBy === 'context') {
    rule += 1;
    const name = 'rule-' + String(rule).padStart(2, '0');
    kept.push({ name, source: CHECKOUT.replace(/\//g, SEP) + SEP + '.agents' + SEP + 'skills' + SEP + name + SEP + 'SKILL.md', matchedBy: 'context' });
  } else if (row.matchedBy === 'index') {
    if (index >= 3) continue;
    index += 1;
    const name = 'index-' + String(index).padStart(2, '0');
    kept.push({ name: 'pack/' + name, source: NEUTRAL_HOME + SEP + '.pr-review' + SEP + 'packs' + SEP + 'pack' + SEP + name + '.md', matchedBy: 'index' });
  } else {
    kept.push(row);
  }
}
done['passes.json'] = JSON.stringify(kept);

const companions = JSON.parse(read('companions.json'));
companions.allInstalled = ['pr-review', ...companions.recognized];
done['companions.json'] = JSON.stringify(companions, null, 2);

const plan = JSON.parse(read('dispatch-plan.json'));
plan.repoRoot = CHECKOUT;
plan.metadata = { ...plan.metadata, headSha: '1'.repeat(40), baseSha: '0'.repeat(40), headBranch: 'feature/change', baseBranch: 'main' };
plan.pr = { ...plan.pr, owner: OWNER, repo: REPO, url: 'https://github.com/' + OWNER + '/' + REPO + '/pull/' + plan.pr.number };
plan.disabledMcpServers = [];
plan.configProjection = { ...plan.configProjection, installedPlugins: [], mcpServers: [] };
plan.reviewers = plan.reviewers.map((r) => ({ ...r, promptTemplate: '<elided>' }));
if (plan.verifier?.promptTemplate) plan.verifier.promptTemplate = '<elided>';
plan.artifacts = plan.artifacts.slice(0, 2);
done['dispatch-plan.json'] = JSON.stringify(plan);

const events = done['reviewer-progress.ndjson'].split('\n').filter(Boolean).map((l) => JSON.parse(l));
const firstSeen = events.filter((e) => e.kind === 'output-first-seen' && e.attempt === 1);
const T = (firstSeen[6] ?? firstSeen[firstSeen.length - 1]).ts + 1;
const cut = (text) => text.split('\n').filter((l) => l.trim() && JSON.parse(l).ts <= T).join('\n') + '\n';

const finalState = JSON.parse(done['delivery-state.json']);
const first = finalState.runtimeAttempts[0];
const runningState = {
  ...finalState,
  updatedAt: first.startedAt,
  kind: 'running',
  valid: [],
  missing: [...finalState.planned],
  invalid: [],
  recoveredFindingCount: 0,
  severityCounts: Object.fromEntries(Object.keys(finalState.severityCounts).map((k) => [k, 0])),
  reviewerAttempts: Object.fromEntries(finalState.planned.map((n) => [n, 1])),
  reviewerDigests: {},
  runtimeAttempts: [{ ...first, status: 'started', endedAt: first.startedAt, exitCode: -1, timedOut: false, durationMs: 0, adoptedReviewers: [] }],
  phase1: 'missing',
  consolidated: 'missing',
  verifier: { state: 'not-evaluated', attempts: 0 },
  reasonCodes: ['runtime-attempt-running'],
};
const running = {
  'progress.ndjson': cut(done['progress.ndjson']),
  'reviewer-progress.ndjson': cut(done['reviewer-progress.ndjson']),
  'delivery-state.json': JSON.stringify(runningState, null, 2),
  'companions.json': JSON.stringify({ ...companions, completedDispatches: 0, completedReviewers: [] }, null, 2),
  'passes.json': done['passes.json'],
  'dispatch-plan.json': done['dispatch-plan.json'],
  'run.pid': done['run.pid'],
};

const header = `// Generated by scripts/mod-fixtures.mjs from a real run directory on ${new Date().toISOString().slice(0, 10)}:
// real shapes, neutral identity (owner/repo, run id, branches, SHAs, checkout path, project
// rule names and paths, installed plugins, the reviewer's home). Prompts elided, artifact
// list trimmed. The mod test kit has no file access, so the run dir is a map of file name
// to content.
//
// RUNNING is the same run cut at T = ${new Date(T).toISOString()} (${T}), just after the
// 7th reviewer's output was first seen in the initial batch: feed lines with ts <= T, and
// delivery-state.json as single-session.ts writes it while that batch runs.
export const RUN_ID = ${JSON.stringify(RUN)};
export const RUN_DIR = ${JSON.stringify(RUN_DIR)};
export const PR_LABEL = ${JSON.stringify(OWNER + '/' + REPO + ' #' + plan.pr.number)};
export const CUTOFF_MS = ${T};
`;
const dump = (name, map) =>
  `export const ${name}: Record<string, string> = {\n` +
  Object.entries(map).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join('\n') +
  '\n};\n';
const out = header + '\n' + dump('RUNNING', running) + '\n' + dump('DONE', done);

// Refuse to write a fixture that still names the reviewed repository or the reviewer.
const leaks = [];
for (const needle of [originalOwner, originalRepo, ORIGINAL_RUN, originalRoot ? basename(originalRoot) : '']) {
  if (needle && out.includes(needle)) leaks.push(needle);
}
const user = basename(HOME);
if (user && new RegExp('[\\\\/]' + escapeRe(user) + '[\\\\/]').test(out)) leaks.push(user + ' (as a path segment)');
if (leaks.length > 0) {
  console.error('refusing to write: the fixture still carries ' + leaks.join(', '));
  process.exit(1);
}
writeFileSync(outFile, out, 'utf8');
console.log(`${outFile}: ${out.length} bytes; run ${RUN}; running cut at ${new Date(T).toISOString()}; ${plan.reviewers.length} reviewers; ${rule} project rules, ${index} index rows`);
