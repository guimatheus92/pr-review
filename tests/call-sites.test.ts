import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  callSitesSection,
  changedDeclarations,
  declaredName,
  MAX_SYMBOLS,
  SECTION_CAP,
  type CallSitesInput,
} from '../src/dispatch/call-sites.js';
import { runReview } from '../src/commands/review.js';
import type { ChangedFile, GatherOutput } from '../src/types.js';

/** Fixture git: the developer's system/global config must not shape the fixtures. Git rejects the OS null device as a config file on Windows, so the default is an empty file. */
const EMPTY_GITCONFIG = join(mkdtempSync(join(tmpdir(), 'pr-review-gitconfig-')), 'config');
writeFileSync(EMPTY_GITCONFIG, '');
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args],
    {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_GITCONFIG },
    },
  ).trim();
}

function write(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  write(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function changed(path: string, patch: string, status: ChangedFile['status'] = 'modified'): ChangedFile {
  return { path, status, additions: 1, deletions: 0, patch };
}

// ── changedDeclarations ─────────────────────────────────────────────────────

test('changedDeclarations — the declaration each changed line belongs to, across languages', () => {
  const cases: [string, string, string, string[]][] = [
    ['TS signature change', 'a.ts', '@@ -1,3 +1,3 @@\n-export function load(id: string) {\n+export function load(id: string, force = false) {\n   return id;\n }', ['load']],
    ['interface member added → the interface, not the member', 'a.ts', '@@ -1,3 +1,4 @@\n export interface KeyFrameExtraction {\n   frames: string[];\n+  duration: number;\n }', ['KeyFrameExtraction']],
    ['hunk-header function context', 'a.ts', '@@ -10,6 +10,7 @@ export function extractKeyFrames(opts: Options) {\n   const a = 1;\n+  const b = 2;\n   return a;', ['extractKeyFrames']],
    ['Python def', 'a.py', '@@ -1,2 +1,2 @@\n def parse_frames(raw):\n-    return raw\n+    return raw.strip()', ['parse_frames']],
    ['Go receiver func', 'a.go', '@@ -1,3 +1,3 @@\n func (s *Server) HandleFrames(w http.ResponseWriter) {\n-\treturn\n+\ts.log()', ['HandleFrames']],
    ['C# modifier method', 'A.cs', '@@ -1,3 +1,3 @@\n     public async Task<int> CountFrames(string id)\n     {\n-        return 0;\n+        return 1;', ['CountFrames']],
    ['Rust pub fn', 'a.rs', '@@ -1,2 +1,2 @@\n-pub fn decode_frame(x: u8) -> u8 {\n+pub(crate) fn decode_frame(x: u16) -> u16 {', ['decode_frame']],
    ['indented local const is not a declaration', 'a.ts', '@@ -1,3 +1,3 @@\n function outerWork() {\n-  const inner = 1;\n+  const inner = 2;', ['outerWork']],
    ['`if (x) {` is not a declaration', 'a.ts', '@@ -1,4 +1,4 @@\n function guarded() {\n   if (ready) {\n-    go();\n+    stop();', ['guarded']],
    ['a call with a callback is not a declaration', 'a.ts', '@@ -1,4 +1,4 @@\n function outerCall() {\n   register(name, function () {\n-    go();\n+    stop();', ['outerCall']],
    ['a markdown file is prose', 'README.md', '@@ -1 +1 @@\n-# old\n+export function documented() {}', []],
    ['short and generic names are not search keys', 'a.ts', '@@ -1,2 +1,2 @@\n-function go() {}\n+function go(x) {}\n   constructor(a) {\n+    this.a = a;', []],
  ];
  for (const [label, path, patch, expected] of cases) {
    assert.deepEqual(changedDeclarations([changed(path, patch)]), expected, label);
  }
  assert.equal(declaredName('  if (x) {'), null);
  assert.equal(declaredName('  const local = 1;'), null);
  assert.equal(declaredName('type FrameMap = Record<string, number>;'), 'FrameMap');
  assert.equal(declaredName('data class Frame(val at: Double)'), 'Frame');
  assert.equal(declaredName('fun render(frame: Frame) {'), 'render');
  assert.equal(declaredName('    def self.build'), null, 'a Ruby singleton def reads as `self`, never searched');
  const started = Date.now();
  assert.equal(declaredName(`  load(): ${' '.repeat(200_000)}x`), null);
  assert.ok(Date.now() - started < 1000, 'a long branch-authored line cannot stall the patterns (quadratic backtracking: ~20 s unguarded)');
});

test('changedDeclarations — a changed declaration line outranks a body change; added files rank last; capped', () => {
  const modified = changed(
    'lib.ts',
    '@@ -1,8 +1,8 @@\n function bodyOnly() {\n-  return 1;\n+  return 2;\n }\n-function sigChanged(a) {\n+function sigChanged(a, b) {\n   return a;\n }',
  );
  const added = changed('fresh.ts', '@@ -0,0 +1,1 @@\n+export function brandNew() {}', 'added');
  assert.deepEqual(changedDeclarations([added, modified]), ['sigChanged', 'bodyOnly', 'brandNew']);
  const many = Array.from({ length: 20 }, (_, i) => `+export function name${String(i).padStart(2, '0')}() {}`).join('\n');
  const names = changedDeclarations([changed('many.ts', `@@ -0,0 +1,20 @@\n${many}`)]);
  assert.equal(names.length, MAX_SYMBOLS);
  assert.equal(names[0], 'name00');
  assert.deepEqual(changedDeclarations([{ ...modified, excluded: true }]), [], 'an excluded file contributes nothing');
});

// ── callSitesSection ────────────────────────────────────────────────────────

const LIB = (head: boolean) =>
  [
    'export interface Result {',
    '  frames: string[];',
    ...(head ? ['  duration: number;'] : []),
    '}',
    '',
    'export function extract(input: string): Result {',
    "  const frames = input.split(',');",
    head ? '  return { frames, duration: frames.length };' : '  return { frames };',
    '}',
    ...Array.from({ length: 12 }, (_, i) => `// filler ${i}`),
    "export const SAMPLE = extract('a,b');",
    '',
  ].join('\n');

const CALLER = [
  "import { extract } from './lib';",
  '',
  'export function run(input: string): number {',
  '  const result = extract(input);',
  '  return result.frames.length;',
  '}',
  '',
].join('\n');

/** base: lib.ts + a caller outside the diff (plus a test, a build output and a doc that reference it) → head: `duration` added to `Result`. */
function prRepo(origin = 'https://github.com/pr-review/eval.git') {
  const repo = mkdtempSync(join(tmpdir(), 'pr-review-call-sites-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  const baseSha = commit(repo, {
    'lib.ts': LIB(false),
    'caller.ts': CALLER,
    'a.test.ts': "import { extract } from './lib';\nextract('x');\n",
    'dist/x.js': "extract('x'); Result;\n",
    'docs/x.md': 'Call extract() to get a Result.\n',
  }, 'base');
  const headSha = commit(repo, { 'lib.ts': LIB(true) }, 'head');
  const diff = git(repo, 'diff', '-U3', baseSha, headSha, '--', 'lib.ts');
  const file: ChangedFile = { path: 'lib.ts', status: 'modified', additions: 2, deletions: 1, patch: diff.slice(diff.indexOf('@@')) };
  return { repo, baseSha, headSha, file };
}

function input(over: Partial<CallSitesInput> & Pick<CallSitesInput, 'root' | 'headSha' | 'files'>): CallSitesInput {
  return { prRepo: true, changedPaths: over.files.map((f) => f.path), excludes: [], ...over };
}

test('callSitesSection — at the PR head: references outside the Diff, non-test files first, generated and prose paths never searched', () => {
  const { repo, headSha, file } = prRepo();
  try {
    const { section, summary } = callSitesSection(input({ root: repo, headSha, files: [file] }));
    assert.match(section, /^## Call sites\n\n/);
    assert.ok(section.includes(`whole-word text search of the PR head (\`${headSha.slice(0, 12)}\`)`), section);
    assert.match(section, /^- `Result` — no reference outside the Diff$/m);
    assert.match(section, /^- `extract` — 5 reference\(s\) in 3 file\(s\)$/m);
    assert.ok(section.indexOf('`Result`') < section.indexOf('`extract`'), 'symbols keep their rank order');
    assert.match(section, /^ {2}4: {3}const result = extract\(input\);$/m, 'the caller outside the Diff is a reference');
    assert.match(section, /^ {2}5- {3}return result\.frames\.length;$/m, 'with its surrounding lines');
    assert.match(section, /^ {2}22: export const SAMPLE = extract\('a,b'\);$/m, 'the defining file is not dropped wholesale');
    assert.doesNotMatch(section, /export interface Result|export function extract|duration/, 'Diff lines and the declarations themselves are left out');
    assert.doesNotMatch(section, /dist\/x\.js|docs\/x\.md/);
    const order = ['### caller.ts', '### lib.ts', '### a.test.ts'].map((h) => section.indexOf(h));
    assert.ok(order[0]! >= 0 && order[0]! < order[1]! && order[1]! < order[2]!, `non-test files first: ${order}`);
    assert.match(summary, /^call sites: 2 declaration\(s\), 5 reference\(s\) in 3 file\(s\) at PR head$/);

    const trusted = callSitesSection(input({ root: repo, headSha, files: [file], excludes: ['**/*.test.ts'] }));
    assert.doesNotMatch(trusted.section, /a\.test\.ts/, 'configured diff_excludes apply to the search too');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('callSitesSection — PR head absent: searches local HEAD, says so, and drops every file the PR changes', () => {
  const { repo, headSha, file } = prRepo();
  try {
    const { section, summary } = callSitesSection(input({ root: repo, headSha: 'f'.repeat(40), files: [{ ...file, previousPath: 'old-lib.ts' }] }));
    assert.ok(section.includes(`this checkout's HEAD (\`${headSha.slice(0, 12)}\`), NOT the PR head \`ffffffffffff\``), section);
    assert.doesNotMatch(section, /### lib\.ts/, 'the local copy of a changed file is not the PR version');
    assert.match(section, /### caller\.ts/);
    assert.match(section, /^- `Result` — no reference outside the files this PR changes$/m);
    assert.match(summary, /at local HEAD [0-9a-f]{12} \(PR head not in this checkout\)$/);
    assert.match(callSitesSection(input({ root: repo, headSha: '--output=x', files: [file] })).summary, /at local HEAD/, 'a non-hex head id never reaches git');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('callSitesSection — says why in one line when it cannot search', () => {
  const { repo, headSha, file } = prRepo();
  const unborn = mkdtempSync(join(tmpdir(), 'pr-review-call-sites-unborn-'));
  try {
    const reason = (over: Partial<CallSitesInput>) => callSitesSection(input({ root: repo, headSha, files: [file], ...over })).section;
    assert.equal(reason({ prRepo: false }), "## Call sites\n\n_Not computed: the checkout is not this PR's repository._");
    assert.equal(reason({ files: [changed('README.md', '@@ -1 +1 @@\n-a\n+b')] }), '## Call sites\n\n_Not computed: no declarations changed._');
    git(unborn, 'init', '-q');
    assert.equal(reason({ root: unborn, headSha: 'a'.repeat(40) }), '## Call sites\n\n_Not computed: no commit to search._');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    assert.equal(reason({}), '## Call sites\n\n_Not computed: partial clone: searching could fetch objects._');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(unborn, { recursive: true, force: true });
  }
});

test('callSitesSection — bounded: a common name is counted, not listed; many callers stay under the cap; long lines are clipped', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pr-review-call-sites-bounds-'));
  try {
    git(repo, 'init', '-q', '-b', 'main');
    const lib = 'export function widely() {}\nexport function alphaFn() {}\nexport function betaFn() {}\nexport function gammaFn() {}\n';
    const files: Record<string, string> = { 'lib.ts': lib, 'used.ts': 'widely();\n'.repeat(30) };
    const filler = `// ${'x'.repeat(300)}`;
    ['alphaFn', 'betaFn', 'gammaFn'].forEach((sym, s) => {
      for (let i = 0; i < 20; i++) {
        files[`c${s}${String(i).padStart(2, '0')}.ts`] = [...Array(6).fill(filler), `${sym}();`, ...Array(6).fill(filler), ''].join('\n');
      }
    });
    const headSha = commit(repo, files, 'all');
    const patch = '@@ -0,0 +1,4 @@\n' + lib.trimEnd().split('\n').map((line) => `+${line}`).join('\n');
    const { section } = callSitesSection(input({ root: repo, headSha, files: [changed('lib.ts', patch, 'added')] }));
    assert.match(section, /^- `widely` — 30 references: too common to list$/m);
    assert.doesNotMatch(section, /### used\.ts/, 'a too-common name gets no snippets');
    assert.match(section, /^- `alphaFn` — 20 reference\(s\) in 20 file\(s\)$/m);
    assert.ok(section.length <= SECTION_CAP, `section is ${section.length} chars`);
    assert.match(section, /_Truncated: \d+ more file\(s\) with references not shown \(section capped at 16000 characters\)\._$/);
    for (const line of section.split('\n').filter((l) => /^ {2}\d+[:-] /.test(l))) {
      assert.ok(line.length <= 2 + 3 + 2 + 200 + 1, `clipped: ${line.length}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('runReview --context-only --from-gather — pr-context.md carries the call sites from the checkout', async () => {
  const { repo, baseSha, headSha, file } = prRepo();
  const home = mkdtempSync(join(tmpdir(), 'pr-review-call-sites-home-'));
  const runDir = mkdtempSync(join(tmpdir(), 'pr-review-call-sites-run-'));
  const previous = process.cwd();
  try {
    writeFileSync(join(repo, '.pr-review.yaml'), 'skill_packs: []\ncompanion_warn: false\n');
    const gather: GatherOutput = {
      pr: { provider: 'github', url: 'https://github.com/pr-review/eval/pull/1', owner: 'pr-review', repo: 'eval', number: 1 },
      metadata: {
        title: 'Add duration', description: 'Lets the caller skip a redundant probe.', author: 'eval', headSha, baseSha,
        baseBranch: 'main', headBranch: 'eval', labels: [], linkedItems: [],
        createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', isDraft: false, state: 'open',
      },
      changedFiles: [file],
      existingComments: [],
      gatheredAt: '2026-01-01T00:00:00Z',
    };
    const gatherFile = join(runDir, 'input-gather.json');
    writeFileSync(gatherFile, JSON.stringify(gather), 'utf8');
    process.chdir(repo);
    const result = await runReview({
      prUrl: gather.pr.url, dryRun: true, publish: false, withCodex: false, withCompanions: false, noCompanionWarning: true,
      runtime: 'copilot', homeOverride: home, contextOnly: true, runDir, fromGather: gatherFile,
      selectPassesFn: () => ({
        passes: [{ name: 'trusted/pass', source: '/trusted.md', body: 'trusted', matchedBy: 'baseline', matchedOn: [] }],
        projectSkills: [], indexEntries: [], stackTags: [],
        routes: [{ name: 'trusted/pass', source: '/trusted.md', matchedBy: 'baseline' }], missingBaseline: [],
      }),
    });
    assert.equal(result.exitCode, 0);
    const context = readFileSync(join(runDir, 'pr-context.md'), 'utf8');
    const sites = context.indexOf('\n## Call sites\n');
    assert.ok(context.indexOf('## Changed Files') < sites && sites < context.indexOf('\n## Diff'), 'between Changed Files and the Diff');
    assert.ok(context.includes(`search of the PR head (\`${headSha.slice(0, 12)}\`)`));
    assert.match(context, /### caller\.ts\n\n```\n[\s\S]*?^ {2}4: {3}const result = extract\(input\);$/m);
  } finally {
    process.chdir(previous);
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  }
});
