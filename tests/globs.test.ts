import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchesAny, filterFiles } from '../src/util/globs.js';

test('matchesAny — empty pattern list matches everything', () => {
  assert.equal(matchesAny('src/foo.ts', []), true);
});

test('matchesAny — exact path', () => {
  assert.equal(matchesAny('src/foo.ts', ['src/foo.ts']), true);
  assert.equal(matchesAny('src/foo.ts', ['src/bar.ts']), false);
});

test('matchesAny — single-segment glob', () => {
  assert.equal(matchesAny('foo.ts', ['*.ts']), true);
  assert.equal(matchesAny('foo.js', ['*.ts']), false);
  assert.equal(matchesAny('a/foo.ts', ['*.ts']), false);
});

test('matchesAny — double-star matches across directories', () => {
  assert.equal(matchesAny('src/foo.ts', ['**/*.ts']), true);
  assert.equal(matchesAny('src/nested/deep/foo.ts', ['**/*.ts']), true);
  assert.equal(matchesAny('foo.ts', ['**/*.ts']), true);
});

test('matchesAny — vendor exclusion pattern', () => {
  assert.equal(matchesAny('node_modules/foo/bar.js', ['**/node_modules/**']), true);
  assert.equal(matchesAny('src/foo.ts', ['**/node_modules/**']), false);
});

test('matchesAny — brace alternation', () => {
  assert.equal(matchesAny('foo.png', ['**/*.{png,jpg}']), true);
  assert.equal(matchesAny('foo.jpg', ['**/*.{png,jpg}']), true);
  assert.equal(matchesAny('foo.gif', ['**/*.{png,jpg}']), false);
});

test('matchesAny — normalizes Windows-style backslash paths', () => {
  assert.equal(matchesAny('src\\foo.ts', ['**/*.ts']), true);
});

test('matchesAny — Controller suffix pattern', () => {
  assert.equal(matchesAny('Controllers/UserController.cs', ['**/*Controller.cs']), true);
  assert.equal(matchesAny('Models/User.cs', ['**/*Controller.cs']), false);
});

test('filterFiles — empty pattern list returns everything', () => {
  const files = [{ path: 'a.ts' }, { path: 'b.cs' }];
  assert.deepEqual(filterFiles(files, []), files);
});

test('filterFiles — filters by glob', () => {
  const files = [{ path: 'src/a.ts' }, { path: 'src/b.cs' }, { path: 'docs/c.md' }];
  const result = filterFiles(files, ['**/*.cs']);
  assert.deepEqual(result, [{ path: 'src/b.cs' }]);
});
