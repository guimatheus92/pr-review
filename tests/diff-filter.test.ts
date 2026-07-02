import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { applyDiffExclusions, summarizeExclusions } from '../src/dispatch/diff-filter.js';
import type { ChangedFile } from '../src/types.js';

function file(path: string): ChangedFile {
  return { path, status: 'modified', additions: 1, deletions: 1, patch: '--- diff ---' };
}

test('excludes lockfiles', () => {
  const files = [file('package-lock.json'), file('src/foo.ts')];
  const result = applyDiffExclusions(files);
  assert.equal(result[0]!.excluded, true);
  assert.equal(result[1]!.excluded, undefined);
});

test('excludes generated and vendor dirs', () => {
  const files = [
    file('vendor/lib.go'),
    file('__generated__/foo.ts'),
    file('node_modules/foo/index.js'),
    file('src/real.ts'),
  ];
  const result = applyDiffExclusions(files);
  assert.equal(result[0]!.excluded, true);
  assert.equal(result[1]!.excluded, true);
  assert.equal(result[2]!.excluded, true);
  assert.equal(result[3]!.excluded, undefined);
});

test('excludes binary file extensions', () => {
  const files = [file('img/logo.png'), file('build/bin/app.exe'), file('docs/photo.jpg'), file('src/code.ts')];
  const result = applyDiffExclusions(files);
  assert.equal(result[0]!.excluded, true);
  assert.equal(result[1]!.excluded, true);
  assert.equal(result[2]!.excluded, true);
  assert.equal(result[3]!.excluded, undefined);
});

test('strips patch content from excluded files', () => {
  const files = [file('package-lock.json')];
  const result = applyDiffExclusions(files);
  assert.equal(result[0]!.patch, undefined);
});

test('supports extra exclusion globs', () => {
  const files = [file('src/legacy/foo.ts'), file('src/modern/bar.ts')];
  const result = applyDiffExclusions(files, ['**/legacy/**']);
  assert.equal(result[0]!.excluded, true);
  assert.equal(result[1]!.excluded, undefined);
});

test('summarizeExclusions reports counts', () => {
  const files = applyDiffExclusions([file('package-lock.json'), file('a.ts'), file('b.ts'), file('vendor/x.go')]);
  const exc = summarizeExclusions(files);
  assert.equal(exc.kept, 2);
  assert.equal(exc.excluded, 2);
  assert.deepEqual(exc.excludedNames.sort(), ['package-lock.json', 'vendor/x.go']);
});
