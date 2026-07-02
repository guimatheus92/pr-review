import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node\n';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/cli.cjs',
  banner: { js: SHEBANG },
  external: ['node:*'],
  legalComments: 'none',
  minify: true,
  logLevel: 'info',
  // single version source: package.json (tsc rootDir blocks a direct import)
  define: { __PR_REVIEW_VERSION__: JSON.stringify(version) },
});

try {
  chmodSync('dist/cli.cjs', 0o755);
} catch {
  // chmod is a no-op on Windows; harmless
}
