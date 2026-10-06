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
 * test is the copy CI can run on every push.
 */
const ROOT = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { hooks?: string };
const hooksJsonPath = join(ROOT, manifest.hooks ?? 'hooks/hooks.json');
const hooksJson = JSON.parse(readFileSync(hooksJsonPath, 'utf8')) as { modules?: string[] };
const modulePath = join(dirname(hooksJsonPath), hooksJson.modules?.[0] ?? '');
/** The module without its line comments: prose may mention `$.noun.method`; code may not. */
const source = readFileSync(modulePath, 'utf8').replace(/^\s*\/\/.*$/gm, '');

/** What the mod may ask Claude Code to do: read the run directory, keep time, draw. */
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
]);

/** What it never may: anything that writes, spawns, posts, prompts, spends or reaches out. */
const FORBIDDEN =
  /\$\.(fs\.write|process\.|prompt\.|http\.|model\.|tool\.|agent\.|session\.(send|append|compact|authorize)|env\.set|store\.|mcp\.|audio\.|turn\.|config\.set|settings\.)/;

/** The events a reader needs: the session, Bash launches/polls, its own command, drawing. */
const ALLOWED_EVENTS = new Set(['session.start', 'session.end', 'tool.call', 'command.run', 'ui.render']);

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

test('mod-surface — the module never writes, spawns, posts, prompts or spends', () => {
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
    const isCall = /^\.[a-z]+\.[A-Za-z]+\(/.test(rest);
    const isArgument = /^[,)]/.test(rest);
    const endsRegex = /^\//.test(rest);
    assert.ok(isCall || isArgument || endsRegex, `a $ that is neither a full $.noun.method( call nor a bare argument at offset ${match.index}: ${JSON.stringify(rest.slice(0, 20))}`);
  }
});

test('mod-surface — the Bash observer passes every command on exactly as it came', () => {
  // The hook's strongest capability is not a $ call: it is `next`. A rewritten command would
  // run a process of the mod's choosing and pass every allowlist above.
  const start = source.indexOf("on('tool.call'");
  const end = source.indexOf("on('command.run'", start);
  assert.ok(start >= 0 && end > start, 'the tool.call hook was not found');
  const handler = source.slice(start, end);
  const calls = handler.match(/\bnext\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 2, `expected the handler to call next, found ${calls.length}`);
  for (const call of calls) assert.equal(call, 'next(e)', `a rewritten or answered tool call: ${call}`);
});

test('mod-surface — the only pane the module opens is its own', () => {
  const opens = [...source.matchAll(/\$\.ui\.open\(\{\s*id:\s*([A-Za-z_'"-]+)/g)].map((m) => m[1]);
  assert.ok(opens.length > 0);
  for (const id of opens) assert.equal(id, 'PANE');
  assert.match(source, /^const PANE = 'pr-review-live';$/m);
});

test('mod-surface — control: a module that writes, spawns or posts is refused by these rules', () => {
  assert.match("await $.fs.write(path, text)", FORBIDDEN);
  assert.match("await $.process.run(['gh', 'pr', 'comment'])", FORBIDDEN);
  assert.match('$.prompt.submit({ text })', FORBIDDEN);
  assert.match('$.model.complete({ prompt })', FORBIDDEN);
  assert.ok(!ALLOWED_CALLS.has('$.fs.write'));
  assert.ok(!ALLOWED_EVENTS.has('prompt.submit'));
  // The alias and rewrite rules can fail too.
  const dollarRule = (text: string) => [...text.matchAll(/\$/g)].every((m) => /^\.[a-z]+\.[A-Za-z]+\(|^[,)]|^\//.test(text.slice(m.index! + 1, m.index! + 40)));
  assert.equal(dollarRule('const fs = $.fs; fs.write(p, t)'), false);
  assert.equal(dollarRule("$['fs'].write(p, t)"), false);
  assert.equal(dollarRule('const { fs } = $;'), false);
  assert.equal(dollarRule('attach($, id); $.fs.read(p)'), true);
  const rewrite = "next({ ...e, command: 'gh pr comment' })";
  assert.notEqual(rewrite.match(/\bnext\([^)]*\)/)?.[0], 'next(e)');
});
