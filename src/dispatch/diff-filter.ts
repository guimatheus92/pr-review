import { matchesAny } from '../util/globs.js';
import type { ChangedFile } from '../types.js';

export const DEFAULT_EXCLUDES = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/go.sum',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/.terraform.lock.hcl',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/vendor/**',
  '**/__generated__/**',
  '**/generated/**',
  '**/*.generated.*',
  '**/*.pb.go',
  '**/*.pb.ts',
  '**/*.designer.cs',
  '**/AssemblyInfo.cs',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/*.{png,jpg,jpeg,gif,svg,ico,pdf,zip,tar,gz,bin,exe,dll,so,dylib,woff,woff2,ttf,eot}',
];

export function applyDiffExclusions(files: ChangedFile[], extraExcludes: string[] = []): ChangedFile[] {
  const patterns = [...DEFAULT_EXCLUDES, ...extraExcludes];
  return files.map((f) => {
    if (matchesAny(f.path, patterns)) {
      return { ...f, excluded: true, excludedReason: 'matched diff-exclusion glob', patch: undefined };
    }
    return f;
  });
}

export function summarizeExclusions(files: ChangedFile[]): { kept: number; excluded: number; excludedNames: string[] } {
  const kept = files.filter((f) => !f.excluded);
  const excluded = files.filter((f) => f.excluded);
  return {
    kept: kept.length,
    excluded: excluded.length,
    excludedNames: excluded.map((f) => f.path),
  };
}
