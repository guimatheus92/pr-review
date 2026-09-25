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

interface CallSite { file: string; line: number; text: string }

/** Balanced-paren slice starting at the `(` at `open`. */
function callText(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open, i + 1);
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
 * Every call in `src` that reaches `node:child_process`: the imported names,
 * `promisify(...)` aliases of them, and injectable parameters typed
 * `typeof <fn>` (the providers' `resolveToken(host, exec = execFileSync)`).
 */
export function childProcessCalls(file: string, raw: string): CallSite[] {
  const src = stripComments(raw);
  const imp = /import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/.exec(src);
  if (!imp) return [];
  const names = new Set(
    imp[1]!.split(',').map((s) => s.trim().split(/\s+as\s+/))
      .filter(([orig]) => CHILD_PROCESS_FNS.includes(orig!))
      .map((parts) => parts.pop()!),
  );
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*promisify\((\w+)\)/g)) if (names.has(m[2]!)) names.add(m[1]!);
  for (const m of src.matchAll(/(\w+)\??\s*:\s*typeof\s+(\w+)/g)) if (names.has(m[2]!)) names.add(m[1]!);
  if (names.size === 0) return [];
  const re = new RegExp(`(?<![.\\w])(${[...names].join('|')})\\s*\\(`, 'g');
  const calls: CallSite[] = [];
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const before = src.slice(0, m.index);
    // A name in a type position (`typeof exec`) or handed to promisify is not a call site.
    if (/typeof\s+$|promisify\($/.test(before)) continue;
    calls.push({ file, line: before.split('\n').length, text: callText(src, open) });
  }
  return calls;
}

export function isHidden(call: CallSite): boolean {
  return /windowsHide\s*:\s*true/.test(call.text) || /\.\.\.GIT_EXEC\b/.test(call.text);
}

/**
 * Every way `src` reaches child_process that `childProcessCalls` cannot see:
 * any mention of the module outside a named `import { … } from 'node:child_process'`
 * (a default or namespace import, the unprefixed name, `require`, dynamic `import()`).
 */
export function unscannableImports(file: string, raw: string): string[] {
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

test('INV-HYG-04 — src/ reaches child_process only in the form the scanner reads', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const hits = tsFiles(root).flatMap((f) => unscannableImports(relative(root, f), readFileSync(f, 'utf8')));
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

test('INV-HYG-04 — every node:child_process call in src/ passes windowsHide', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const calls = tsFiles(root).flatMap((f) => childProcessCalls(relative(root, f), readFileSync(f, 'utf8')));
  // A scanner that matches nothing passes on every input; the floor (the call
  // sites that existed when INV-HYG-04 landed) stops a regex regression going silent.
  assert.ok(calls.length >= 16, `only ${calls.length} child_process call(s) found — the scanner stopped matching`);
  const visible = calls.filter((c) => !isHidden(c)).map((c) => `${c.file}:${c.line}`);
  assert.deepEqual(visible, [], `child processes that would open a console window on win32:\n${visible.join('\n')}`);
});

test('INV-HYG-04 — GIT_EXEC, which gitOut spreads, carries windowsHide', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'src', 'util', 'git.ts'), 'utf8');
  const decl = /const GIT_EXEC = \{[^}]*\}/.exec(src);
  assert.ok(decl, 'GIT_EXEC declaration not found');
  assert.match(decl[0], /windowsHide:\s*true/);
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
  assert.deepEqual(calls.map((c) => [c.line, isHidden(c)]), [[5, false], [6, true], [7, false]]);
});

/** `.kill(` on anything but `process` — a ChildProcess, whatever it is named. */
export function childKills(file: string, raw: string): string[] {
  return stripComments(raw).split('\n').flatMap((line, i) =>
    /(?<!\bprocess)\??\.kill\(/.test(line.replace(/\bprocess\.kill\(/g, '')) ? [`${file}:${i + 1}`] : []);
}

test('INV-HYG-04 — no ChildProcess.kill() in src/: on win32 it ends only the shell, use killTree', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const hits = tsFiles(root).flatMap((f) => childKills(relative(root, f), readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('INV-HYG-04 control — the kill scan flags any receiver but process', () => {
  const src = ['child.kill();', "proc.kill('SIGKILL');", 'this.runtime?.kill();', 'process.kill(pid, 0);', '// child.kill() in prose'].join('\n');
  assert.deepEqual(childKills('f.ts', src), ['f.ts:1', 'f.ts:2', 'f.ts:3']);
});
