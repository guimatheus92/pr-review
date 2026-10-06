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
});
