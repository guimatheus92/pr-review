import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * INV-HYG-04. A detached run has no console, so on Windows every console child
 * started without `windowsHide` gets a fresh console — and Windows 11 hands it
 * to Windows Terminal as a new empty window. Nothing observable in CI tells a
 * hidden child from a visible one, so the guard is the source itself: every
 * call into `node:child_process` must say `windowsHide`.
 */

const CHILD_PROCESS_FNS = ['execFileSync', 'execSync', 'execFile', 'exec', 'spawnSync', 'spawn', 'fork'];

/** The one deliberate detached launch: `--detach` starting the review process itself. */
const DETACH_LAUNCHER = join('commands', 'detach.ts');

interface CallSite { file: string; line: number; text: string }

/** Balanced slice starting at the `(` or `{` at `open`. */
function balanced(src: string, open: number): string {
  const [o, c] = src[open] === '{' ? ['{', '}'] : ['(', ')'];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/**
 * Blank out comments, keeping newlines so line numbers survive: prose like
 * "exec (not execFile)" is not a call. `://` is left alone for URLs in strings.
 */
function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_, p: string) => p);
}

/**
 * Every call in `src` that reaches `node:child_process`: the names imported by
 * every named import of it, plus the names bound to one of those — a
 * `promisify(...)` alias, a plain re-binding (`const run = execFileSync;`) and
 * an injectable parameter typed `typeof <fn>` (the providers'
 * `resolveToken(host, exec = execFileSync)`).
 */
function childProcessCalls(file: string, raw: string): CallSite[] {
  const src = stripComments(raw);
  const names = new Set<string>();
  for (const imp of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g)) {
    for (const [orig, alias] of imp[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/))) {
      if (CHILD_PROCESS_FNS.includes(orig!)) names.add(alias ?? orig!);
    }
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:promisify\((\w+)\)|(\w+)\s*;)/g)) {
    if (names.has((m[2] ?? m[3])!)) names.add(m[1]!);
  }
  for (const m of src.matchAll(/(\w+)\??\s*:\s*typeof\s+(\w+)/g)) if (names.has(m[2]!)) names.add(m[1]!);
  if (names.size === 0) return [];
  const re = new RegExp(`(?<![.\\w])(${[...names].join('|')})\\s*\\(`, 'g');
  const calls: CallSite[] = [];
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const before = src.slice(0, m.index);
    // A name in a type position (`typeof exec`) or handed to promisify is not a call site.
    if (/typeof\s+$|promisify\($/.test(before)) continue;
    calls.push({ file, line: before.split('\n').length, text: balanced(src, open) });
  }
  return calls;
}

/** The object literal `name` is declared as in `src`, or null when this file declares none. */
function declaredObject(src: string, name: string): string | null {
  const m = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
  return m ? balanced(src, m.index + m[0].length - 1) : null;
}

/**
 * Hidden: `windowsHide: true` in the call's options, or in an object literal
 * they spread that this same file declares — a spread is resolved, never
 * trusted by its name, so a `GIT_EXEC` copied into another module is checked
 * where it lands. Refused either way: a `windowsHide` that is not `true`, and
 * `detached: true` outside the one deliberate detached launch — on win32
 * DETACHED_PROCESS voids windowsHide's CREATE_NO_WINDOW, leaving the child no
 * console, so each console child it starts opens a window.
 */
function isHidden(call: CallSite, src: string): boolean {
  const spreads = [...call.text.matchAll(/\.\.\.(\w+)/g)].map(([, name]) => declaredObject(src, name!) ?? '');
  const text = [call.text, ...spreads].join('\n');
  if (/windowsHide\s*:(?!\s*true\b)/.test(text)) return false;
  if (/detached\s*:\s*true/.test(text) && call.file !== DETACH_LAUNCHER) return false;
  return /windowsHide\s*:\s*true/.test(text);
}

/**
 * Every way `src` reaches child_process that `childProcessCalls` cannot see:
 * any mention of the module outside a named `import { … } from 'node:child_process'`
 * (a default or namespace import, the unprefixed name, `require`, dynamic `import()`).
 */
function unscannableImports(file: string, raw: string): string[] {
  const src = stripComments(raw);
  const named = /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*['"]node:child_process['"]/g;
  const mentions = src.match(/['"](?:node:)?child_process['"]/g)?.length ?? 0;
  const scanned = src.match(named)?.length ?? 0;
  return mentions > scanned ? [file] : [];
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return tsFiles(join(dir, e.name));
    return e.name.endsWith('.ts') ? [join(dir, e.name)] : [];
  });
}

const SRC = join(import.meta.dirname, '..', 'src');
const srcFiles = () => tsFiles(SRC).map((f) => ({ file: relative(SRC, f), src: readFileSync(f, 'utf8') }));

test('INV-HYG-04 — src/ reaches child_process only in the form the scanner reads', () => {
  const hits = srcFiles().flatMap(({ file, src }) => unscannableImports(file, src));
  assert.deepEqual(hits, [], 'use `import { … } from \'node:child_process\'` so the windowsHide scan covers the file');
});

test('INV-HYG-04 control — every import shape the scanner cannot read is refused', () => {
  for (const line of [
    "import * as cp from 'node:child_process';",
    "import cp from 'node:child_process';",
    "import { execSync } from 'child_process';",
    "const cp = require('node:child_process');",
    "const cp = await import('node:child_process');",
  ]) assert.deepEqual(unscannableImports('f.ts', line), ['f.ts'], line);
  assert.deepEqual(unscannableImports('f.ts', "import { spawn, type ChildProcess } from 'node:child_process';"), []);
});

// Pinned, not a floor: a floor lets a call site fall out of the scan with the
// count still above it. A new call site moves this number on purpose.
const CHILD_PROCESS_CALL_SITES = 19;

test('INV-HYG-04 — every node:child_process call in src/ passes windowsHide', () => {
  const files = srcFiles();
  const calls = files.flatMap(({ file, src }) => childProcessCalls(file, src).map((call) => ({ call, src })));
  assert.equal(
    calls.length,
    CHILD_PROCESS_CALL_SITES,
    `the scanner found ${calls.length} child_process call site(s), not ${CHILD_PROCESS_CALL_SITES}: check each new one ` +
      `passes windowsHide and move the constant, or find which one it stopped matching:\n` +
      calls.map(({ call }) => `${call.file}:${call.line}`).join('\n'),
  );
  const visible = calls.filter(({ call, src }) => !isHidden(call, stripComments(src))).map(({ call }) => `${call.file}:${call.line}`);
  assert.deepEqual(visible, [], `child processes that would open a console window on win32:\n${visible.join('\n')}`);
});

test('INV-HYG-04 control — the scanner flags a visible child and accepts a hidden one', () => {
  const src = [
    "import { execFileSync, execFile as ef } from 'node:child_process';",
    "import { promisify } from 'node:util';",
    'const run = promisify(ef);',
    "export function tok(host: string, exec: typeof execFileSync = execFileSync) {",
    "  exec('gh', ['auth', 'token'], { encoding: 'utf8' });",
    "  execFileSync('git', ['status'], { stdio: 'ignore', windowsHide: true });",
    "  return run('git', ['log'], { cwd: host });",
    '}',
    "/x/.exec('not a child process');",
  ].join('\n');
  const calls = childProcessCalls('fixture.ts', src);
  assert.deepEqual(calls.map((c) => [c.line, isHidden(c, src)]), [[5, false], [6, true], [7, false]]);
});

test('INV-HYG-04 control — a second import and a re-bound name are scanned too', () => {
  const src = [
    "import { spawn } from 'node:child_process';",
    "import { execFileSync } from 'node:child_process';",
    'const again = execFileSync;',
    "spawn('a', [], { windowsHide: true });",
    "execFileSync('b', [], { encoding: 'utf8' });",
    "again('c', [], { encoding: 'utf8' });",
  ].join('\n');
  assert.deepEqual(childProcessCalls('fixture.ts', src).map((c) => [c.line, isHidden(c, src)]), [[4, true], [5, false], [6, false]]);
});

test('INV-HYG-04 control — a spread counts only as what its declaration in the same file says', () => {
  const src = [
    "import { execFileSync } from 'node:child_process';",
    "const HIDDEN = { encoding: 'utf8' as const, env: { A: '1' }, windowsHide: true };",
    "const BARE = { encoding: 'utf8' as const };",
    "execFileSync('git', [], { ...HIDDEN, cwd: 'x' });",
    "execFileSync('git', [], { ...BARE, cwd: 'x' });",
    "execFileSync('git', [], { ...IMPORTED_FROM_ELSEWHERE });",
    "execFileSync('git', [], { ...HIDDEN, windowsHide: false });",
  ].join('\n');
  assert.deepEqual(childProcessCalls('fixture.ts', src).map((c) => [c.line, isHidden(c, src)]), [[4, true], [5, false], [6, false], [7, false]]);
});

test('INV-HYG-04 control — detached voids windowsHide, so it is refused outside the detach launcher', () => {
  const src = ["import { spawn } from 'node:child_process';", "spawn(process.execPath, [], { detached: true, windowsHide: true });"].join('\n');
  const [call] = childProcessCalls('fixture.ts', src);
  assert.equal(isHidden(call!, src), false);
  assert.equal(isHidden({ ...call!, file: DETACH_LAUNCHER }, src), true);
});

/** `.kill(` on anything but `process` — a ChildProcess, whatever it is named. */
function childKills(file: string, raw: string): string[] {
  return stripComments(raw).split('\n').flatMap((line, i) => /(?<!\bprocess)\??\.kill\(/.test(line) ? [`${file}:${i + 1}`] : []);
}

test('INV-HYG-04 — no ChildProcess.kill() in src/: on win32 it ends only the shell, use killTree', () => {
  assert.deepEqual(srcFiles().flatMap(({ file, src }) => childKills(file, src)), []);
});

test('INV-HYG-04 control — the kill scan flags any receiver but process', () => {
  const src = ['child.kill();', "proc.kill('SIGKILL');", 'this.runtime?.kill();', 'process.kill(pid, 0);', '// child.kill() in prose'].join('\n');
  assert.deepEqual(childKills('f.ts', src), ['f.ts:1', 'f.ts:2', 'f.ts:3']);
});

/**
 * Every `spawnCli(` whose child is not handed to `killOnExit` — a runtime the
 * exit sweep would never end. The definition and its overloads are skipped.
 */
function unregisteredSpawns(file: string, raw: string): string[] {
  const src = stripComments(raw);
  return [...src.matchAll(/(?<![.\w])spawnCli\s*\(/g)].flatMap((m) => {
    const before = src.slice(0, m.index);
    if (/function\s+$/.test(before)) return [];
    const bound = /(\w+)\s*=\s*$/.exec(before)?.[1];
    return bound && new RegExp(`\\bkillOnExit\\(\\s*${bound}\\s*\\)`).test(src) ? [] : [`${file}:${before.split('\n').length}`];
  });
}

test('INV-HYG-04 — every spawnCli child in src/ is registered with killOnExit', () => {
  const files = srcFiles();
  const sites = files.flatMap(({ src }) => [...stripComments(src).matchAll(/(?<![.\w])spawnCli\s*\(/g)]).length;
  assert.ok(sites > 3, 'the spawnCli scan matched nothing beyond the definition');
  assert.deepEqual(files.flatMap(({ file, src }) => unregisteredSpawns(file, src)), [], 'a child no killOnExit sees outlives a CLI that exits first');
});

test('INV-HYG-04 control — the registration scan flags a spawnCli child nobody registers', () => {
  const src = [
    'const a = spawnCli(bin, [], opts);',
    'killOnExit(a);',
    'const b = spawnCli(bin, [], opts);',
    'spawnCli(bin, [], opts).stdin.end();',
    'export function spawnCli(binary: string) {}',
  ].join('\n');
  assert.deepEqual(unregisteredSpawns('f.ts', src), ['f.ts:3', 'f.ts:4']);
});
