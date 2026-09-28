import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  describeReap,
  exitSweep,
  killOnExit,
  killTree,
  namesRunDir,
  parseProcessTable,
  pidAlive,
  posixKillTargets,
  reapOrphanRuntime,
  reapThenClaimRunPid,
  spawnCli,
  type ProcessRow,
  type ReapDeps,
} from '../src/util/spawn.js';
import { RUNTIMES, runtimeSpawnArgs } from '../src/dispatch/runtime.js';
import { CODEX_SANDBOX_ARGS, codexSpawnArgs } from '../src/dispatch/codex.js';
import { DEAD_PID, gone, idleRuntime } from './idle-runtime.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const SPAWN_URL = pathToFileURL(join(REPO_ROOT, 'src', 'util', 'spawn.ts')).href;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    assert.equal(killTree(child), null, 'killTree reported a kill that did not happen');
    assert.ok(await gone(pid), `runtime pid ${pid} survived killTree`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — killTree also ends what the runtime itself started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-killtree-sub-'));
  const subPidFile = join(root, 'sub.pid');
  let subPid = 0;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const sub = join(root, 'sub.js');
    writeFileSync(sub, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);", 'utf8');
    // A runtime that starts a tool subprocess of its own, then idles. On POSIX the
    // subprocess is re-parented to init when the runtime dies, unless it is killed too.
    const runtime = join(root, 'runtime.js');
    writeFileSync(
      runtime,
      `require('child_process').spawn(process.execPath, [${JSON.stringify(sub)}, ${JSON.stringify(subPidFile)}], { stdio: 'ignore', windowsHide: true }); setInterval(() => {}, 1000);`,
      'utf8',
    );
    const runtimeChild = spawnCli(process.execPath, [runtime], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = runtimeChild;
    runtimeChild.stdin.end();
    for (let i = 0; i < 100 && !existsSync(subPidFile); i++) await sleep(50);
    subPid = Number(readFileSync(subPidFile, 'utf8'));
    assert.ok(subPid > 0);
    assert.equal(killTree(runtimeChild), null);
    assert.ok(await gone(subPid), `the runtime's own subprocess ${subPid} outlived killTree`);
  } finally {
    // A regression must fail here, not hang the runner on a survivor's pipes.
    if (subPid && pidAlive(subPid)) process.kill(subPid);
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});

/** A stand-in CLI: spawn a runtime through spawnCli, register it, and report when its pid is on disk. */
function writeStandInCli(root: string, tail: string[]): { cli: string; pidFile: string } {
  const idle = join(root, 'idle.js');
  const pidFile = join(root, 'idle.pid');
  writeFileSync(idle, "require('fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);", 'utf8');
  const cli = join(root, 'cli.mts');
  writeFileSync(cli, [
    `import { existsSync } from 'node:fs';`,
    `import { killOnExit, spawnCli } from ${JSON.stringify(SPAWN_URL)};`,
    `const child = spawnCli(process.execPath, [${JSON.stringify(idle)}, ${JSON.stringify(pidFile)}], { stdio: ['pipe', 'pipe', 'pipe'] });`,
    `child.stdin.end();`,
    `killOnExit(child);`,
    `for (let i = 0; i < 100 && !existsSync(${JSON.stringify(pidFile)}); i++) await new Promise((r) => setTimeout(r, 50));`,
    ...tail,
  ].join('\n'), 'utf8');
  return { cli, pidFile };
}

test('INV-HYG-04 — killOnExit takes the runtime down when the CLI process exits first', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-onexit-'));
  try {
    // Exit mid-flight the way a fatal error does. Nothing else in it would kill the runtime.
    const { cli, pidFile } = writeStandInCli(root, ['process.exit(3);']);
    const res = spawnSync(process.execPath, ['--import', 'tsx', cli], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
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

test(
  'INV-HYG-04 — SIGTERM to the CLI takes the runtime down with it',
  { skip: process.platform === 'win32' && 'win32 has no SIGTERM a handler can see: process.kill terminates outright' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-review-onsignal-'));
    try {
      // Under the default disposition a signal ends the process without `exit`, so
      // killOnExit's hook would never run — the way `kill <pid>` leaked the session.
      const { cli, pidFile } = writeStandInCli(root, [`process.stdout.write('ready');`, 'setInterval(() => {}, 1000);']);
      const proc = spawn(process.execPath, ['--import', 'tsx', cli], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const closed = new Promise<number | null>((resolve) => proc.on('close', resolve));
      await new Promise<void>((resolve, reject) => {
        proc.stdout.on('data', (d: Buffer) => { if (String(d).includes('ready')) resolve(); });
        void closed.then((code) => reject(new Error(`stand-in CLI exited ${code} before it was ready`)));
      });
      const pid = Number(readFileSync(pidFile, 'utf8'));
      process.kill(proc.pid!, 'SIGTERM');
      assert.equal(await closed, 143);
      const dead = await gone(pid);
      if (!dead) process.kill(pid);
      assert.ok(dead, `runtime ${pid} outlived a SIGTERM to its CLI`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('INV-HYG-04 — killOnExit installs one exit hook and one per signal, however many children come and go', async () => {
  // This file's first killOnExit: the hooks go in here, and only once.
  const events = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const before = events.map((e) => process.listenerCount(e));
  for (let i = 0; i < 3; i++) {
    const c = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    killOnExit(c);
    await new Promise((r) => c.on('close', r));
  }
  assert.deepEqual(events.map((e, i) => process.listenerCount(e) - before[i]!), [1, 1, 1, 1]);
});

test('INV-HYG-04 — namesRunDir matches the argv the real producers build, and nothing else', () => {
  // Pure string logic: both command-line shapes are asserted on every platform.
  for (const shape of [
    { dir: 'C:\\Users\\me\\.pr-review\\runs\\gh__o__r__1__T1', repo: 'D:\\repo', join: win32.join, sep: '\\', quoted: true },
    { dir: '/home/me/.pr-review/runs/gh__o__r__1__T1', repo: '/repo', join: posix.join, sep: '/', quoted: false },
  ]) {
    const { dir } = shape;
    // The command line spawnCli produces: every part quoted on win32, bare elsewhere.
    const line = (argv: string[]) => (shape.quoted ? argv.map((a) => `"${a}"`).join(' ') : argv.join(' '));
    const at = `${shape.quoted ? 'win32' : 'posix'} shape`;

    // Positives come from the producers, so renaming a flag there fails here too.
    for (const rt of RUNTIMES) {
      assert.equal(namesRunDir(line([rt, ...runtimeSpawnArgs(rt, 'm', dir, shape.repo)]), dir), true, `${rt}, ${at}`);
    }
    assert.equal(namesRunDir(line(['codex', ...codexSpawnArgs(dir, shape.join(dir, 'o.json'))]), dir), true, `codex, ${at}`);

    // An editor with a file of the run dir open is not a runtime.
    assert.equal(namesRunDir(line(['notepad', shape.join(dir, 'pr-review-summary.md')]), dir), false, at);
    // Nor is one that opened the run dir itself.
    assert.equal(namesRunDir(line(['code', dir]), dir), false, at);
    assert.equal(namesRunDir(line(['explorer', `${dir}${shape.sep}`]), dir), false, at);
    // Nor this CLI, which names its run dir too (detach, resume) — status must never kill it.
    assert.equal(namesRunDir(line(['node', 'cli.cjs', 'review', 'https://x/pull/1', '--no-codex', '--no-cache', '--run-dir', dir]), dir), false, at);
    assert.equal(namesRunDir(line(['node', 'cli.cjs', 'review', 'https://x/pull/1', '--resume', basename(dir), '--run-dir', dir]), dir), false, at);
    // Nor an operator's own session on the run dir: the flag alone is not the identity.
    assert.equal(namesRunDir(line(['claude', '--add-dir', dir]), dir), false, at);
    // Nor any other -C/-c — only codex's -C, alongside codex's own sandbox flag.
    assert.equal(namesRunDir(line(['make', '-C', dir]), dir), false, at);
    assert.equal(namesRunDir(line(['tar', '-C', dir, '-xf', 'x.tar']), dir), false, at);
    assert.equal(namesRunDir(line(['sh', '-c', dir]), dir), false, at);
    assert.equal(namesRunDir(line(['codex', ...CODEX_SANDBOX_ARGS, '-c', dir]), dir), false, at);
    // A sibling run whose id extends this one is not this run.
    assert.equal(namesRunDir(line(['claude', ...runtimeSpawnArgs('claude', 'm', `${dir}0`)]), dir), false, at);
  }
  // The path folds as foldPath folds it — case and separators — while the flags stay exact.
  const winDir = 'C:\\Users\\me\\.pr-review\\runs\\gh__o__r__1__T1';
  const winLine = ['claude', ...runtimeSpawnArgs('claude', 'm', winDir.toUpperCase())].map((a) => `"${a}"`).join(' ');
  assert.equal(namesRunDir(winLine, winDir.replace(/\\/g, '/')), true);
});

test('INV-HYG-04 — a process table without this process in it is refused as unread', () => {
  // A CIM query can fail without failing: PowerShell exits 0 and prints nothing.
  assert.equal(typeof parseProcessTable('', 42), 'string');
  assert.equal(typeof parseProcessTable('7\t1\tclaude --add-dir /x\n', 42), 'string');
  // Nor is one that lists this process but cannot read its command line.
  assert.equal(typeof parseProcessTable('42\t1\t\n7\t1\tclaude\n', 42), 'string');
  assert.deepEqual(parseProcessTable('42\t1\tnode cli.cjs\r\n    7     1 /usr/bin/claude --add-dir /x\n', 42), [
    { pid: 42, ppid: 1, cmd: 'node cli.cjs' },
    { pid: 7, ppid: 1, cmd: '/usr/bin/claude --add-dir /x' },
  ]);
});

test('INV-HYG-04 — reapOrphanRuntime kills the runtime of a dead run, even after its shell died', async () => {
  // Non-ASCII on purpose: PowerShell 5.1 wrote the table in the OEM code page, and a
  // profile path like this one came back mangled and never matched.
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-João-'));
  try {
    const { child, pid } = await idleRuntime(outDir, runtimeSpawnArgs('claude', 'm', outDir));
    writeFileSync(join(outDir, 'run.pid'), String(DEAD_PID), 'utf8');
    // Reproduce the live failure: a hard kill of the CLI took the cmd.exe in
    // front of the runtime with it, so the runtime must be found by its own argv.
    if (process.platform === 'win32') process.kill(child.pid!);
    assert.ok(pidAlive(pid));
    const r = reapOrphanRuntime(outDir);
    assert.ok('killed' in r, JSON.stringify(r));
    assert.deepEqual(r.killed.map((p) => p.pid), [pid]);
    assert.deepEqual(r.survived, []);
    assert.ok(await gone(pid), `orphaned runtime ${pid} still alive`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('INV-HYG-04 — reapOrphanRuntime spares everything it does not own', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-keep-'));
  const other = mkdtempSync(join(tmpdir(), 'pr-review-reap-other-'));
  const nothing = { killed: [], survived: [] };
  try {
    const mine = await idleRuntime(outDir, runtimeSpawnArgs('claude', 'm', outDir));
    const theirs = await idleRuntime(other, runtimeSpawnArgs('claude', 'm', other));

    await t.test('a live run is not an orphan', () => {
      writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
      assert.deepEqual(reapOrphanRuntime(outDir), nothing);
      assert.ok(pidAlive(mine.pid));
    });

    await t.test('no run.pid means no owner to judge, so nothing is killed', () => {
      rmSync(join(outDir, 'run.pid'));
      assert.deepEqual(reapOrphanRuntime(outDir), nothing);
      assert.ok(pidAlive(mine.pid));
    });

    await t.test('a dead run reaps only its own runtime, never another run\'s', async () => {
      writeFileSync(join(outDir, 'run.pid'), String(DEAD_PID), 'utf8');
      const r = reapOrphanRuntime(outDir);
      // The root of this run's tree is the child spawnCli returned: cmd.exe on win32.
      assert.ok('killed' in r, JSON.stringify(r));
      assert.deepEqual(r.killed.map((p) => p.pid), [mine.child.pid]);
      assert.ok(await gone(mine.pid));
      assert.ok(pidAlive(theirs.pid), 'another run\'s runtime was killed');
    });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

/** A process-table row for a runtime this CLI spawned for `outDir`, quoted the way spawnCli quotes on win32. */
function runtimeRow(outDir: string, pid: number, ppid = 1, image = 'C:\\tools\\claude.exe'): ProcessRow {
  return { pid, ppid, cmd: [image, ...runtimeSpawnArgs('claude', 'm', outDir)].map((a) => `"${a}"`).join(' ') };
}

/** Deps that record every kill and answer `why` for it (null: killed). */
function recording(table: ReapDeps['table'], why: string | null = null): ReapDeps & { kills: number[] } {
  const kills: number[] = [];
  return { kills, table, killPid: (pid) => { kills.push(pid); return why; } };
}

/** A run dir whose run.pid names a dead process. */
function deadRun(t: { after: (fn: () => void) => void }): string {
  const outDir = mkdtempSync(join(tmpdir(), 'pr-review-reap-seam-'));
  writeFileSync(join(outDir, 'run.pid'), String(DEAD_PID), 'utf8');
  t.after(() => rmSync(outDir, { recursive: true, force: true }));
  return outDir;
}

test('INV-HYG-04 — an unreadable process table is reported, and nothing is killed', (t) => {
  const outDir = deadRun(t);
  const deps = recording(() => 'powershell.exe exit 1: Get-CimInstance : Access denied');
  const r = reapOrphanRuntime(outDir, deps);
  assert.deepEqual(r, { scanError: 'could not read the process table: powershell.exe exit 1: Get-CimInstance : Access denied' });
  assert.deepEqual(deps.kills, []);
  assert.match(describeReap(r)!, /NOT checked — could not read the process table: powershell\.exe exit 1/);
});

test('INV-HYG-04 — an unreadable run.pid is reported, never read as "no owner"', (t) => {
  const outDir = deadRun(t);
  writeFileSync(join(outDir, 'run.pid'), '', 'utf8');
  const deps = recording(() => [runtimeRow(outDir, 4242)]);
  const r = reapOrphanRuntime(outDir, deps);
  assert.ok('scanError' in r && /run\.pid holds "", not a pid/.test(r.scanError), JSON.stringify(r));
  assert.deepEqual(deps.kills, []);
});

test('INV-HYG-04 — a kill that fails is reported as survived, with its image and reason, never as killed', (t) => {
  const outDir = deadRun(t);
  const r = reapOrphanRuntime(outDir, recording(() => [runtimeRow(outDir, 4242)], 'taskkill exit 1: Access is denied.'));
  assert.deepEqual(r, { killed: [], survived: [{ name: 'claude.exe', pid: 4242, why: 'taskkill exit 1: Access is denied.' }] });
  const line = describeReap(r)!;
  assert.match(line, /could NOT kill orphaned runtime claude\.exe pid 4242 \(taskkill exit 1: Access is denied\.\) — end it manually/);
  assert.doesNotMatch(line, /killed its/);
});

test('INV-HYG-04 — only the root of a matched tree is killed: its matched children go down with it', (t) => {
  const outDir = deadRun(t);
  const runtime = runtimeRow(outDir, 101, 100);
  // The cmd.exe that ran it names the same argv inside its /c string.
  const shell = { pid: 100, ppid: 1, cmd: `C:\\WINDOWS\\system32\\cmd.exe /d /s /c "${runtime.cmd}"` };
  const deps = recording(() => [shell, runtime]);
  const r = reapOrphanRuntime(outDir, deps);
  assert.deepEqual(deps.kills, [100]);
  assert.deepEqual(r, { killed: [{ name: 'cmd.exe', pid: 100 }], survived: [] });
});

test('INV-HYG-04 — each target is re-read just before the kill', async (t) => {
  const outDir = deadRun(t);
  const row = runtimeRow(outDir, 4242);

  await t.test('one that exited since the scan is not killed', () => {
    const deps = recording((pids) => (pids ? [] : [row]));
    assert.deepEqual(reapOrphanRuntime(outDir, deps), { killed: [], survived: [] });
    assert.deepEqual(deps.kills, []);
  });

  await t.test('one whose pid now runs something else is not killed', () => {
    const deps = recording((pids) => (pids ? [{ ...row, cmd: 'C:\\Windows\\notepad.exe' }] : [row]));
    assert.deepEqual(reapOrphanRuntime(outDir, deps), { killed: [], survived: [] });
    assert.deepEqual(deps.kills, []);
  });

  await t.test('a --resume that claimed run.pid meanwhile owns the sessions', () => {
    const deps = recording((pids) => {
      if (pids) writeFileSync(join(outDir, 'run.pid'), String(process.pid), 'utf8');
      return [row];
    });
    assert.deepEqual(reapOrphanRuntime(outDir, deps), { killed: [], survived: [] });
    assert.deepEqual(deps.kills, []);
  });

  await t.test('a re-read that fails kills nothing, and says so', () => {
    writeFileSync(join(outDir, 'run.pid'), String(DEAD_PID), 'utf8');
    const deps = recording((pids) => (pids ? 'ps ETIMEDOUT' : [row]));
    const r = reapOrphanRuntime(outDir, deps);
    assert.deepEqual(r, { scanError: 'could not re-read the matched processes before the kill: ps ETIMEDOUT' });
    assert.deepEqual(deps.kills, []);
  });
});

test('INV-HYG-04 — --resume sweeps before it claims run.pid, and refuses while a session survives', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-claim-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outDir = join(root, 'gh__o__r__1__T1');
  mkdirSync(outDir);
  const row = runtimeRow(outDir, 4242);
  const pidFile = join(outDir, 'run.pid');

  // Claimed first, the sweep would read this process's own live pid and kill nothing.
  writeFileSync(pidFile, String(DEAD_PID), 'utf8');
  const deps = recording(() => [row]);
  assert.match(reapThenClaimRunPid(outDir, root, deps)!, /killed its orphaned runtime session \(claude\.exe pid 4242\)/);
  assert.deepEqual(deps.kills, [4242]);
  assert.equal(readFileSync(pidFile, 'utf8'), String(process.pid));
  assert.match(readFileSync(join(outDir, 'progress.ndjson'), 'utf8'), /"phase":"reap","detail":"run process died — killed its orphaned runtime session/);

  // A session that survives its kill would keep writing into the attempts about to be
  // recovered: refuse, and leave run.pid unclaimed so the next try sweeps again.
  writeFileSync(pidFile, String(DEAD_PID), 'utf8');
  assert.throws(
    () => reapThenClaimRunPid(outDir, root, recording(() => [row], 'SIGKILL EPERM')),
    /resume recovery refused \[orphan-runtime-alive\]: .*could NOT kill orphaned runtime claude\.exe pid 4242 \(SIGKILL EPERM\)/,
  );
  assert.equal(readFileSync(pidFile, 'utf8'), String(DEAD_PID));

  // A run dir outside the runs root is not swept at all — it cannot be one of this
  // CLI's runs — and is still claimed.
  const elsewhere = mkdtempSync(join(tmpdir(), 'pr-review-claim-out-'));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  writeFileSync(join(elsewhere, 'run.pid'), String(DEAD_PID), 'utf8');
  let scanned = 0;
  assert.equal(reapThenClaimRunPid(elsewhere, root, { table: () => { scanned++; return [row]; }, killPid: () => null }), null);
  assert.equal(scanned, 0);
  assert.equal(readFileSync(join(elsewhere, 'run.pid'), 'utf8'), String(process.pid));
});

test('INV-HYG-04 — describeReap reports what happened, never a kill that did not', () => {
  assert.equal(describeReap({ killed: [], survived: [] }), null);
  assert.match(describeReap({ killed: [{ name: 'node.exe', pid: 7 }], survived: [] })!, /killed its orphaned runtime session \(node\.exe pid 7\)/);
  const refused = describeReap({ killed: [], survived: [{ name: 'claude.exe', pid: 9, why: 'taskkill exit 1: Access is denied.' }] })!;
  assert.match(refused, /could NOT kill orphaned runtime claude\.exe pid 9 \(taskkill exit 1: Access is denied\.\)/);
  assert.doesNotMatch(refused, /killed its/);
  // Both at once: one line, the kill and the refusal side by side.
  const mixed = describeReap({ killed: [{ name: 'node', pid: 7 }], survived: [{ name: 'codex', pid: 9, why: 'SIGKILL EPERM' }] })!;
  assert.match(mixed, /killed its orphaned runtime session \(node pid 7\); could NOT kill orphaned runtime codex pid 9 \(SIGKILL EPERM\)/);
  assert.match(describeReap({ scanError: 'could not read the process table: ps ENOENT' })!, /NOT checked — could not read the process table: ps ENOENT/);
});

test('INV-HYG-04 — POSIX: an unread process table kills the root only, and never reads as a complete kill', () => {
  const table: ProcessRow[] = [
    { pid: process.pid, ppid: 1, cmd: 'node test' },
    { pid: 10, ppid: 1, cmd: 'claude' },
    { pid: 11, ppid: 10, cmd: 'rg' },
    { pid: 12, ppid: 11, cmd: 'rg worker' },
    { pid: 13, ppid: 1, cmd: 'unrelated' },
  ];
  assert.deepEqual(posixKillTargets(10, table), { targets: [10, 11, 12], unreached: null });
  const unread = posixKillTargets(10, 'ps ENOENT: spawn ps ENOENT');
  assert.deepEqual(unread.targets, [10]);
  assert.match(unread.unreached ?? '', /descendants were NOT killed.*ps ENOENT/);
});

test('INV-HYG-04 — the exit sweep names every child it could not kill', () => {
  const child = (pid: number, spawnfile: string) => ({ pid, spawnfile }) as unknown as import('node:child_process').ChildProcess;
  const lines: string[] = [];
  const reasons = new Map([[21, null], [22, 'taskkill exit 1: ERROR: Access is denied.']]);
  exitSweep([child(21, 'claude'), child(22, 'C:\\WINDOWS\\system32\\cmd.exe')], (c) => reasons.get(c.pid!) ?? null, (l) => lines.push(l));
  assert.equal(lines.length, 1, lines.join(''));
  assert.match(lines[0]!, /could NOT kill cmd\.exe pid 22 .*Access is denied.*end it manually/);
});
