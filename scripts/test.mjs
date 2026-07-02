// Node 20's `node --test` does not accept glob patterns (added in 21+), and
// directory mode does not discover .ts files. Enumerate here so the suite
// runs identically on every supported Node version with no hardcoded list.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = readdirSync('tests')
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `tests/${f}`);
if (files.length === 0) {
  console.error('no test files found under tests/');
  process.exit(1);
}
const result = spawnSync(process.execPath, ['--test', '--import', 'tsx', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
