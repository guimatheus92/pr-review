import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { killTree, namesRunDir, pidAlive, reapOrphanRuntime, spawnCli } from '../src/util/spawn.js';

/** Every idle runtime started here. If a kill under test regresses, the survivor would hold
 * this file open forever; kill it by pid so the regression FAILS instead of hanging. */
const spawned: { child: ReturnType<typeof spawnCli>; pid: number }[] = [];
after(() => {
  for (const s of spawned) {
    if (pidAlive(s.pid)) process.kill(s.pid);
    s.child.stdout.destroy();
    s.child.stderr.destroy();
  }
});

/** A long-lived node process that writes its own pid to `pidFile`, launched through spawnCli like a runtime. */
async function idleRuntime(root: string, extraArgs: string[]): Promise<{ child: ReturnType<typeof spawnCli>; pid: number }> {
  const script = join(root, 'idle.js');
  const pidFile = join(root, `idle-${Date.now()}.pid`);
  writeFileSync(script, `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`, 'utf8');
  const child = spawnCli(process.execPath, [script, pidFile, ...extraArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  for (let i = 0; i < 100; i++) {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (pid > 0) {
        spawned.push({ child, pid });
        return { child, pid };
      }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('idle runtime never started');
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** A pid that is certainly dead: a process that already exited. */
async function deadPid(): Promise<number> {
  const c = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise((r) => c.on('close', r));
  return c.pid!;
}

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

test('INV-HYG-04 — namesRunDir recognizes a runtime handed the run dir, not a reader of it', () => {
  const dir = process.platform === 'win32' ? 'C:\\Users\\me\\.pr-review\\runs\\gh__o__r__1__T1' : '/home/me/.pr-review/runs/gh__o__r__1__T1';
  const q = (s: string) => (process.platform === 'win32' ? `"${s}"` : s);
  assert.equal(namesRunDir(`claude ${q('-p')} ${q('--add-dir')} ${q(dir)} ${q('--add-dir')} ${q('/repo')}`, dir), true);
  assert.equal(namesRunDir(`codex exec ${q('-C')} ${q(dir)} ${q('-o')} ${q(join(dir, 'a.json'))}`, dir), true);
  // An editor with a file of the run dir open is not a runtime.
  assert.equal(namesRunDir(`notepad ${q(join(dir, 'pr-review-summary.md'))}`, dir), false);
  // A sibling run whose id extends this one is not this run.
  assert.equal(namesRunDir(`claude ${q('--add-dir')} ${q(`${dir}0`)}`, dir), false);
  if (process.platform === 'win32') {
    assert.equal(namesRunDir(`claude "--add-dir" "${dir.toLowerCase()}"`, dir.replace(/\\/g, '/')), true);
  }
});

test('INV-HYG-04 — reapOrphanRuntime kills the runtime of a dead run, even after its shell died', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-'));
  try {
    const { child, pid } = await idleRuntime(outDir, ['--add-dir', outDir]);
    writeFileSync(join(outDir, 'run.pid'), String(await deadPid()), 'utf8');
    // On win32 kill only the cmd.exe in front of it, as a hard kill of the run
    // did live: the runtime must still be found, by its own argv.
    if (process.platform === 'win32') process.kill(child.pid!);
    assert.ok(pidAlive(pid));
    assert.equal(reapOrphanRuntime(outDir), true);
    assert.ok(await gone(pid), `orphaned runtime ${pid} still alive`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — reapOrphanRuntime leaves a live run, an unknown owner, and other runs alone', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-keep-'));
  const other = mkdtempSync(join(tmpdir(), 'pr-review-reap-other-'));
  try {
    const mine = await idleRuntime(outDir, ['--add-dir', outDir]);
    const theirs = await idleRuntime(other, ['--add-dir', other]);

    // Run still alive: its runtime is not an orphan.
    writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
    assert.equal(reapOrphanRuntime(outDir), false);
    assert.ok(pidAlive(mine.pid));

    // No run.pid at all: nothing says the owner is dead, so nothing is killed.
    rmSync(join(outDir, 'run.pid'));
    assert.equal(reapOrphanRuntime(outDir), false);
    assert.ok(pidAlive(mine.pid));

    // Dead run: only its own runtime goes, never another run's.
    writeFileSync(join(outDir, 'run.pid'), String(await deadPid()), 'utf8');
    assert.equal(reapOrphanRuntime(outDir), true);
    assert.ok(await gone(mine.pid));
    assert.ok(pidAlive(theirs.pid), 'another run\'s runtime was killed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
