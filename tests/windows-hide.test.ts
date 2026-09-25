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
 * Every call in `src` that reaches `node:child_process`: the imported names,
 * `promisify(...)` aliases of them, and injectable parameters typed
 * `typeof <fn>` (the providers' `resolveToken(host, exec = execFileSync)`).
 */
export function childProcessCalls(file: string, raw: string): CallSite[] {
  // Blank out comments, keeping newlines so line numbers survive: prose like
  // "exec (not execFile)" is not a call. `://` is left alone for URLs in strings.
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, (_, p: string) => p);
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
    // Skip the import line, type positions (`typeof exec`) and the promisify argument.
    if (/typeof\s+$|promisify\($/.test(before)) continue;
    calls.push({ file, line: before.split('\n').length, text: callText(src, open) });
  }
  return calls;
}

export function isHidden(call: CallSite): boolean {
  return /windowsHide\s*:\s*true/.test(call.text) || /\.\.\.GIT_EXEC\b/.test(call.text);
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

test('INV-HYG-04 — every node:child_process call in src/ passes windowsHide', () => {
  const root = join(import.meta.dirname, '..', 'src');
  const calls = tsFiles(root).flatMap((f) => childProcessCalls(relative(root, f), readFileSync(f, 'utf8')));
  // A scanner that matches nothing passes on every input. There are 16 call
  // sites as of INV-HYG-04; the floor stops a regex regression going silent.
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
