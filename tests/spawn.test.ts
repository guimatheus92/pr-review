import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { killTree, pidAlive, reapOrphanRuntime, RUNTIME_PID_FILE, spawnCli } from '../src/util/spawn.js';

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
async function idleRuntime(root: string, extraArg: string): Promise<{ child: ReturnType<typeof spawnCli>; pid: number }> {
  const script = join(root, 'idle.js');
  const pidFile = join(root, `idle-${Date.now()}.pid`);
  writeFileSync(script, `require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);`, 'utf8');
  const child = spawnCli(process.execPath, [script, pidFile, extraArg], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    const { child, pid } = await idleRuntime(root, 'x');
    killTree(child);
    assert.ok(await gone(pid), `runtime pid ${pid} survived killTree`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — reapOrphanRuntime kills a runtime whose run process is dead', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-'));
  try {
    const { child, pid } = await idleRuntime(outDir, outDir);
    writeFileSync(join(outDir, 'run.pid'), String(await deadPid()), 'utf8');
    writeFileSync(join(outDir, RUNTIME_PID_FILE), String(child.pid), 'utf8');
    assert.equal(reapOrphanRuntime(outDir), true);
    assert.ok(await gone(pid), `orphaned runtime ${pid} still alive`);
    assert.equal(existsSync(join(outDir, RUNTIME_PID_FILE)), false);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — reapOrphanRuntime leaves a live run and a reused pid alone', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-keep-'));
  const other = mkdtempSync(join(tmpdir(), 'pr-review-reap-other-'));
  const started: ReturnType<typeof spawnCli>[] = [];
  try {
    // Run still alive: its runtime is not an orphan.
    const live = await idleRuntime(outDir, outDir);
    started.push(live.child);
    writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
    writeFileSync(join(outDir, RUNTIME_PID_FILE), String(live.child.pid), 'utf8');
    assert.equal(reapOrphanRuntime(outDir), false);
    assert.ok(pidAlive(live.pid));

    // No run.pid at all: nothing says the owner is dead, so nothing is killed.
    rmSync(join(outDir, 'run.pid'));
    assert.equal(reapOrphanRuntime(outDir), false);
    assert.ok(pidAlive(live.pid));

    // Run dead, but the recorded pid now belongs to a process that is not this
    // run's runtime (pid reuse): its command line does not name the run dir.
    const stranger = await idleRuntime(other, other);
    started.push(stranger.child);
    writeFileSync(join(outDir, 'run.pid'), String(await deadPid()), 'utf8');
    writeFileSync(join(outDir, RUNTIME_PID_FILE), String(stranger.child.pid), 'utf8');
    assert.equal(reapOrphanRuntime(outDir), false);
    assert.ok(pidAlive(stranger.pid));
  } finally {
    for (const c of started) killTree(c);
    rmSync(outDir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
