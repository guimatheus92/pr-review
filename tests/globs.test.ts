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

// `diff_excludes` can come from the checkout's own .pr-review.yaml, i.e. from
// the branch under review — since INV-FETCH-04, those globs reach the matcher
// before the config is rejected as untrusted. Measured on this repo before the
// guard below: `**a**a**…**b` against ONE 40-character path took 3.7 seconds,
// and matchesAny compiles inside its .some(), so a 501-file PR paid it per file.

test('matchesAny — a catastrophically backtracking glob is refused, not matched slowly', () => {
  const evil = '**a**a**a**a**a**a**a**a**b';
  const path = `src/${'a'.repeat(40)}.ts`;
  const started = Date.now();
  const matched = matchesAny(path, [evil]);
  const elapsed = Date.now() - started;
  assert.equal(matched, false, 'failing closed means the file is REVIEWED, never silently hidden');
  assert.ok(elapsed < 500, `over-complex glob took ${elapsed}ms — the complexity guard is not holding`);
});

test('matchesAny — an over-long glob is refused on length alone', () => {
  assert.equal(matchesAny('src/a.ts', [`src/${'a'.repeat(600)}.ts`]), false);
});

test('matchesAny — realistic globs keep working: the guard must not cost the product its exclusions', () => {
  // Every shape DEFAULT_EXCLUDES actually uses, including the widest one.
  const cases: Array<[string, string, boolean]> = [
    ['**/package-lock.json', 'a/b/package-lock.json', true],
    ['**/node_modules/**', 'x/node_modules/y/z.js', true],
    ['**/*.{png,jpg,jpeg,gif,svg,ico,pdf,zip,tar,gz,bin,exe,dll,so,dylib,woff,woff2,ttf,eot}', 'assets/logo.png', true],
    ['**/*.generated.*', 'src/api.generated.ts', true],
    ['**/generated/**', 'src/app.ts', false],
  ];
  for (const [pattern, path, want] of cases) {
    assert.equal(matchesAny(path, [pattern]), want, `${pattern} vs ${path}`);
  }
});

test('matchesAny — four ** segments is still allowed; the cap is above every real pattern', () => {
  assert.equal(matchesAny('a/b/c/d/e.ts', ['**/b/**/d/**']), true);
});
