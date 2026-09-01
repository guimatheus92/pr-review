import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnCli } from '../src/util/spawn.js';

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