import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describeReap, killOnExit, killTree, namesRunDir, pidAlive, reapOrphanRuntime, spawnCli } from '../src/util/spawn.js';
import { RUNTIMES, runtimeSpawnArgs } from '../src/dispatch/runtime.js';
import { CODEX_SANDBOX_ARGS } from '../src/dispatch/codex.js';
import { deadPid, gone, idleRuntime } from './idle-runtime.js';

test('spawnCli — Windows-safe runtime punctuation reaches the child as exact argv', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-spawn-'));
  const dir = join(root, 'José');
  try {
    mkdirSync(dir, { recursive: true });
    const script = join(dir, 'argv.js');
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))', 'utf8');
    const expected = ['--deny-tool=shell', 'Read,Write,Edit', 'mcp__*'];
    const actual = await new Promise<string>((resolve, reject) => {
      const child = spawnCli(process.execPath, [script, ...expected], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`)));
      child.stdin.end();
    });
    assert.deepEqual(JSON.parse(actual), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawnCli — explicit child environment reaches the process without losing inherited values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-spawn-env-'));
  try {
    const script = join(root, 'env.js');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify({ isolated: process.env.COPILOT_PLUGIN_DIR_ONLY, inherited: process.env.PR_REVIEW_TEST_INHERITED }))',
      'utf8',
    );
    const actual = await new Promise<string>((resolve, reject) => {
      const child = spawnCli(process.execPath, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, COPILOT_PLUGIN_DIR_ONLY: '1', PR_REVIEW_TEST_INHERITED: 'present' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`)));
      child.stdin.end();
    });
    assert.deepEqual(JSON.parse(actual), { isolated: '1', inherited: 'present' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — killTree ends the runtime itself, not just the win32 shell in front of it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-killtree-'));
  try {
    const { child, pid } = await idleRuntime(root, []);
    killTree(child);
    assert.ok(await gone(pid), `runtime pid ${pid} survived killTree`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — killOnExit takes the runtime down when the CLI process exits first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-onexit-'));
  try {
    const idle = join(root, 'idle.js');
    const pidFile = join(root, 'idle.pid');
    writeFileSync(idle, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);", 'utf8');
    // A stand-in CLI: spawn a runtime, register it, then exit mid-flight the way a
    // fatal error does. Nothing else in it would kill the runtime.
    const cli = join(root, 'cli.mts');
    const spawnUrl = pathToFileURL(join(import.meta.dirname, '..', 'src', 'util', 'spawn.ts')).href;
    writeFileSync(cli, [
      `import { existsSync } from 'node:fs';`,
      `import { killOnExit, spawnCli } from ${JSON.stringify(spawnUrl)};`,
      `const child = spawnCli(process.execPath, [${JSON.stringify(idle)}, ${JSON.stringify(pidFile)}], { stdio: ['pipe', 'pipe', 'pipe'] });`,
      `child.stdin.end();`,
      `killOnExit(child);`,
      `for (let i = 0; i < 100 && !existsSync(${JSON.stringify(pidFile)}); i++) await new Promise((r) => setTimeout(r, 50));`,
      `process.exit(3);`,
    ].join('\n'), 'utf8');
    const res = spawnSync(process.execPath, ['--import', 'tsx', cli], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(res.status, 3, res.stderr);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 0);
    const dead = await gone(pid);
    if (!dead) process.kill(pid);
    assert.ok(dead, `runtime ${pid} outlived the CLI that registered it`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — killOnExit installs one exit hook, however many children come and go', async () => {
  const before = process.listenerCount('exit');
  for (let i = 0; i < 3; i++) {
    const c = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    killOnExit(c);
    await new Promise((r) => c.on('close', r));
  }
  assert.ok(process.listenerCount('exit') - before <= 1, `${process.listenerCount('exit') - before} exit listeners added`);
});

test('INV-HYG-04 — namesRunDir matches the argv the real producers build, and nothing else', () => {
  const win = process.platform === 'win32';
  const dir = win ? 'C:\\Users\\me\\.pr-review\\runs\\gh__o__r__1__T1' : '/home/me/.pr-review/runs/gh__o__r__1__T1';
  // The command line spawnCli produces: every part quoted on win32, bare elsewhere.
  const line = (argv: string[]) => (win ? argv.map((a) => `"${a}"`).join(' ') : argv.join(' '));

  // Positives come from the producers, so renaming their flag fails here too.
  for (const rt of RUNTIMES) {
    assert.equal(namesRunDir(line([rt, ...runtimeSpawnArgs(rt, 'm', dir, win ? 'D:\\repo' : '/repo')]), dir), true, rt);
  }
  assert.equal(namesRunDir(line(['codex', ...CODEX_SANDBOX_ARGS, '-C', dir, '-o', join(dir, 'o.json'), '-']), dir), true, 'codex');
  if (win) assert.equal(namesRunDir(line(['claude', '--add-dir', dir.toLowerCase()]), dir.replace(/\\/g, '/')), true);

  // An editor with a file of the run dir open is not a runtime.
  assert.equal(namesRunDir(line(['notepad', join(dir, 'pr-review-summary.md')]), dir), false);
  // Nor is one that opened the run dir itself — only the flag tells them apart.
  assert.equal(namesRunDir(line(['code', dir]), dir), false);
  assert.equal(namesRunDir(line(['explorer', `${dir}${win ? '\\' : '/'}`]), dir), false);
  // Nor this CLI, which names its run dir too (detach, resume) — status must never kill it.
  assert.equal(namesRunDir(line(['node', 'cli.cjs', 'review', 'https://x/pull/1', '--no-codex', '--no-cache', '--run-dir', dir]), dir), false);
  assert.equal(namesRunDir(line(['node', 'cli.cjs', 'review', 'https://x/pull/1', '--resume', basename(dir), '--run-dir', dir]), dir), false);
  // A sibling run whose id extends this one is not this run.
  assert.equal(namesRunDir(line(['claude', '--add-dir', `${dir}0`]), dir), false);
});

test('INV-HYG-04 — reapOrphanRuntime kills the runtime of a dead run, even after its shell died', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-'));
  try {
    const { child, pid } = await idleRuntime(outDir, ['--add-dir', outDir]);
    writeFileSync(join(outDir, 'run.pid'), String(await deadPid()), 'utf8');
    // Reproduce the live failure: a hard kill of the CLI took the cmd.exe in
    // front of the runtime with it, so the runtime must be found by its own argv.
    if (process.platform === 'win32') process.kill(child.pid!);
    assert.ok(pidAlive(pid));
    const r = reapOrphanRuntime(outDir);
    assert.ok(r.killed.includes(pid), JSON.stringify(r));
    assert.deepEqual(r.survived, []);
    assert.ok(await gone(pid), `orphaned runtime ${pid} still alive`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — reapOrphanRuntime leaves a live run, an unknown owner, and other runs alone', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-keep-'));
  const other = mkdtempSync(join(tmpdir(), 'pr-review-reap-other-'));
  const nothing = { killed: [], survived: [], scanFailed: false };
  try {
    const mine = await idleRuntime(outDir, ['--add-dir', outDir]);
    const theirs = await idleRuntime(other, ['--add-dir', other]);

    // Run still alive: its runtime is not an orphan.
    writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
    assert.deepEqual(reapOrphanRuntime(outDir), nothing);
    assert.ok(pidAlive(mine.pid));

    // No run.pid at all: nothing says the owner is dead, so nothing is killed.
    rmSync(join(outDir, 'run.pid'));
    assert.deepEqual(reapOrphanRuntime(outDir), nothing);
    assert.ok(pidAlive(mine.pid));

    // Dead run: only its own runtime goes, never another run's.
    writeFileSync(join(outDir, 'run.pid'), String(await deadPid()), 'utf8');
    assert.ok(reapOrphanRuntime(outDir).killed.includes(mine.pid));
    assert.ok(await gone(mine.pid));
    assert.ok(pidAlive(theirs.pid), 'another run\'s runtime was killed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — describeReap reports what happened, never a kill that did not', () => {
  assert.equal(describeReap({ killed: [], survived: [], scanFailed: false }), null);
  assert.match(describeReap({ killed: [7], survived: [], scanFailed: false })!, /killed its orphaned runtime session \(pid 7\)/);
  const refused = describeReap({ killed: [], survived: [9], scanFailed: false })!;
  assert.match(refused, /could NOT kill orphaned runtime pid 9/);
  assert.doesNotMatch(refused, /killed its/);
  assert.match(describeReap({ killed: [], survived: [], scanFailed: true })!, /could not read the process table/);
});
