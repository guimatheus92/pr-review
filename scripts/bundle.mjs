import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node\n';

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
});

try {
  chmodSync('dist/cli.cjs', 0o755);
} catch {
  // chmod is a no-op on Windows; harmless
}
