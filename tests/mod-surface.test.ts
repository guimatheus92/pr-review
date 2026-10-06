import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The live mod (mods/live/hooks/register.js) is a READER of the run directory and nothing
 * else: it never writes a file, starts a process, posts, prompts the model, or spends the
 * user's plan. The CLI is the only writer (INV-POST-06) and every run artifact stays under
 * ~/.pr-review (INV-FETCH-03); a mod runs with the user's permissions inside Claude Code,
 * so the guarantee has to be pinned where the suite runs — here, without the `claude` CLI.
 *
 * `claude plugin validate` lists the same calls (`calls:`) from the same source text; this
 * test is the copy CI can run on every push. The kit tests (mods/live/tests, run by
 * `claude plugin test`) have no file access, so the two product texts they replay — the
 * slash command's launch block and the CLI's detach banner — are pinned to their sources
 * here as well.
 */
const ROOT = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { hooks?: string };
const hooksJsonPath = join(ROOT, manifest.hooks ?? 'hooks/hooks.json');
const hooksJson = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as { modules?: string[] };
const modulePath = join(dirname(hooksJsonPath), hooksJson.modules?.[0] ?? '');
/** The module without its line comments: prose may mention `$.noun.method`; code may not. */
const source = readFileSync(modulePath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
const kitTest = readFileSync(join(dirname(hooksJsonPath), '..', 'tests', 'live.test.ts'), 'utf8');

/** What the mod may ask Claude Code to do: read the run directory, keep time, draw, log to the debug file. */
const ALLOWED_CALLS = new Set([
  '$.command.register',
  '$.clock.now',
  '$.clock.every',
  '$.fs.stat',
  '$.fs.read',
  '$.fs.exists',
  '$.fs.list',
  '$.env.get',
  '$.ui.open',
  '$.ui.close',
  '$.ui.invalidate',
  '$.ui.resolve',
  '$.ui.log',
]);

/**
 * What it never may: anything that writes, spawns, posts, prompts, spends or reaches out —
 * on ANY receiver, so `h($).fs.write(…)` through a helper that returns `$` is refused too.
 */
const FORBIDDEN =
  /\.(fs\.write|process\.|prompt\.|http\.|model\.|tool\.|agent\.|session\.(send|append|compact|authorize)|env\.set|store\.|mcp\.|audio\.|turn\.|config\.set|settings\.)/;

/** The events a reader needs: the session, Bash launches/polls, its own command, drawing. */
const ALLOWED_EVENTS = new Set(['session.start', 'session.end', 'tool.call', 'command.run', 'ui.render']);

/** After a `$`: a full `$.noun.method(` call, a bare argument (`$,` / `$)`), or the end of a regex literal. */
const DOLLAR_OK = /^\.[a-z]+\.[A-Za-z]+\(|^[,)]|^\//;
const dollarRule = (text: string) => [...text.matchAll(/\$/g)].every((m) => DOLLAR_OK.test(text.slice(m.index! + 1, m.index! + 40)));

/** Every `next(…)` call in a handler; the Bash observer may only ever write `next(e)`. */
const NEXT_CALLS = /\bnext\([^)]*\)/g;
/** A mutated or re-assembled event in the Bash observer: `e.command = …`, `Object.assign(e, …)`, `{ ...e, … }`. */
const EVENT_REWRITE = /\be\.[A-Za-z_]+\s*=(?!=)|Object\.assign\(\s*e\b|\{\s*\.\.\.e\b/;

test('mod-surface — the manifest names a hooks module that exists and is an ES module', () => {
  assert.equal(manifest.hooks, './mods/live/hooks/hooks.json', 'the mod is declared from the Claude manifest, not the root hooks/ dir (see AGENTS.md)');
  assert.deepEqual(hooksJson.modules, ['./register.js']);
  assert.ok(existsSync(modulePath), `missing ${modulePath}`);
  assert.match(source, /^export function register\(on\)/m);
  assert.doesNotMatch(source, /\brequire\(|\bimport\(/, 'a hooks module uses import declarations only');
});

test('mod-surface — every mods API call in the module is on the read-only allowlist', () => {
  const calls = new Set(source.match(/\$\.[a-z]+\.[A-Za-z]+/g) ?? []);
  assert.ok(calls.size > 0, 'the module calls nothing on $ — the scan found no calls');
  for (const call of calls) assert.ok(ALLOWED_CALLS.has(call), `unexpected mods API call: ${call}`);
});

test('mod-surface — the module never writes, spawns, posts, prompts or spends, through any receiver', () => {
  assert.doesNotMatch(source, FORBIDDEN);
});

test('mod-surface — every hook is on a documented read-side event, named as a string literal', () => {
  const events = [...source.matchAll(/\bon\(\s*'([a-z.*]+)'/g)].map((m) => m[1]);
  assert.ok(events.length >= 5, `expected at least five hooks, found ${events.length}`);
  for (const event of events) assert.ok(ALLOWED_EVENTS.has(event), `unexpected event: ${event}`);
  assert.doesNotMatch(source, /\bon\(\s*[^'"]/, 'an event name that is not a string literal fails claude plugin validate');
});

test('mod-surface — every $ is a full call or a bare argument: no alias, no destructuring, no computed access', () => {
  // `const fs = $.fs; fs.write(…)` or `$['fs']` would slip past a literal-text allowlist, and the
  // host refuses to load such a module anyway — so the node suite refuses it first, on every OS.
  for (const match of source.matchAll(/\$/g)) {
    const rest = source.slice(match.index! + 1, match.index! + 40);
    assert.ok(DOLLAR_OK.test(rest), `a $ that is neither a full $.noun.method( call nor a bare argument at offset ${match.index}: ${JSON.stringify(rest.slice(0, 20))}`);
  }
});

test('mod-surface — the Bash observer passes every command on exactly as it came', () => {
  // The hook's strongest capability is not a $ call: it is `next`. A rewritten command would
  // run a process of the mod's choosing and pass every allowlist above — whether it is handed
  // to `next` as a new object or written into the event before `next(e)`.
  const start = source.indexOf("on('tool.call'");
  const end = source.indexOf("on('command.run'", start);
  assert.ok(start >= 0 && end > start, 'the tool.call hook was not found');
  const handler = source.slice(start, end);
  const calls = handler.match(NEXT_CALLS) ?? [];
  assert.ok(calls.length >= 2, `expected the handler to call next, found ${calls.length}`);
  for (const call of calls) assert.equal(call, 'next(e)', `a rewritten or answered tool call: ${call}`);
  assert.doesNotMatch(handler, EVENT_REWRITE, 'the Bash event is mutated before it reaches next');
});

test('mod-surface — the only pane the module opens is its own', () => {
  const opens = [...source.matchAll(/\$\.ui\.open\(\{\s*id:\s*([A-Za-z_'"-]+)/g)].map((m) => m[1]);
  assert.ok(opens.length > 0);
  for (const id of opens) assert.equal(id, 'PANE');
  assert.match(source, /^const PANE = 'pr-review-live';$/m);
});

test('mod-surface — the kit replays the launch block of commands/pr-review.md verbatim', () => {
  // The kit test holds the Step 1 bash block as a literal (no file access there); a drift
  // between the two is a launch the mod was never tested against. The block is evaluated the
  // way the test file does (a string plus a String.raw template), then compared to the file.
  const expr = /const STEP1 =\n([\s\S]*?`);\n/.exec(kitTest)?.[1];
  assert.ok(expr, 'STEP1 literal not found in the kit test');
  const step1 = new Function(`return ${expr}`)() as string;
  const command = readFileSync(join(ROOT, 'commands', 'pr-review.md'), 'utf8');
  const block = /## Step 1[^\n]*\n[\s\S]*?```bash\n([\s\S]*?)```/.exec(command)?.[1];
  assert.ok(block, 'Step 1 bash block not found in commands/pr-review.md');
  assert.equal(step1, block.trimEnd(), 'mods/live/tests/live.test.ts STEP1 drifted from commands/pr-review.md Step 1');
});

test('mod-surface — the kit replays the detach banner of src/cli.ts verbatim', () => {
  const cli = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8');
  assert.match(cli, /`Review started in the background \(this can take ~6–10 min\)\.\\n` \+\n\s*`  run-id: \$\{runId\}\\n  dir:    \$\{outDir\}\\n\\n`/);
  assert.match(kitTest, /'Review started in the background \(this can take ~6–10 min\)\.\\n' \+\n\s*`  run-id: \$\{id\}\\n  dir:    \$\{RUNS_ROOT\}\\\\\$\{id\}\\n\\n`/);
  assert.match(source, /^const BANNER = 'Review started in the background';/m);
  assert.match(source, /^const RUN_ID_LINE_RE = \/\^ \{2\}run-id: \(\.\+\?\)\\r\?\$\/m;/m);
});

test('mod-surface — control: a module that writes, spawns, posts or rewrites a command is refused by these rules', () => {
  assert.match('await $.fs.write(path, text)', FORBIDDEN);
  assert.match("await $.process.run(['gh', 'pr', 'comment'])", FORBIDDEN);
  assert.match('$.prompt.submit({ text })', FORBIDDEN);
  assert.match('$.model.complete({ prompt })', FORBIDDEN);
  assert.match('h($).fs.write(path, text)', FORBIDDEN);
  assert.match('const api = h($); api.process.run(cmd)', FORBIDDEN);
  assert.ok(!ALLOWED_CALLS.has('$.fs.write'));
  assert.ok(!ALLOWED_EVENTS.has('prompt.submit'));
  // The alias and rewrite rules can fail too.
  assert.equal(dollarRule('const fs = $.fs; fs.write(p, t)'), false);
  assert.equal(dollarRule("$['fs'].write(p, t)"), false);
  assert.equal(dollarRule('const { fs } = $;'), false);
  assert.equal(dollarRule('attach($, id); $.fs.read(p)'), true);
  assert.notEqual("next({ ...e, command: 'gh pr comment' })".match(NEXT_CALLS)?.[0], 'next(e)');
  assert.match("e.command = 'gh pr comment'; return next(e);", EVENT_REWRITE);
  assert.match("Object.assign(e, { command: 'gh pr comment' })", EVENT_REWRITE);
  assert.match('const e2 = { ...e, command: x }', EVENT_REWRITE);
  assert.doesNotMatch("if (e.command === 'x') return next(e);", EVENT_REWRITE);
});
