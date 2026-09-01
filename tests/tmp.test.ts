import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { controlDirForRun, sanitizeForFilename } from '../src/util/tmp.js';

test('sanitizeForFilename — Windows aliases have distinct portable identities', () => {
  const names = ['foo', 'FOO', 'foo.', 'foo ', 'CON', 'a/b', 'a\\b', 'a:b'];
  const tokens = names.map(sanitizeForFilename);
  assert.equal(new Set(tokens.map((token) => token.toLowerCase())).size, names.length);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9._-]+--[0-9a-f]{12}$/);
    assert.doesNotMatch(token, /[. ]$/);
  }
});

test('sanitizeForFilename — identical input remains deterministic', () => {
  assert.equal(sanitizeForFilename('pack/reviewer'), sanitizeForFilename('pack/reviewer'));
});

test('controlDirForRun — same basename under different roots gets different authority', () => {
  const first = controlDirForRun('C:/one/shared', 'C:/home');
  const second = controlDirForRun('C:/two/shared', 'C:/home');
  assert.notEqual(first, second);
  assert.match(first.replace(/\\/g, '/'), /\/control\/shared--[0-9a-f]{16}$/);
});