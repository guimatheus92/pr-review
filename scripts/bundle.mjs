import { buildSync } from 'esbuild';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHEBANG = '#!/usr/bin/env node\n';

export function buildBundle(root = process.cwd(), outfile = join(root, 'dist', 'cli.cjs'), logLevel = 'info') {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  mkdirSync(dirname(outfile), { recursive: true });
  buildSync({
    absWorkingDir: root,
    entryPoints: ['src/cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile,
    banner: { js: SHEBANG },
    external: ['node:*'],
    legalComments: 'none',
    minify: true,
    logLevel,
    // single version source: package.json (tsc rootDir blocks a direct import)
    define: { __PR_REVIEW_VERSION__: JSON.stringify(version) },
  });

  try {
    chmodSync(outfile, 0o755);
  } catch {
    // chmod is a no-op on Windows; harmless
  }
  return outfile;
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  buildBundle();
}
