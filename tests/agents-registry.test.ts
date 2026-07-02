import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import { BUILTIN_AGENTS } from '../src/dispatch/single-session.js';

test('agents/*.md and BUILTIN_AGENTS stay in lockstep (verifier included)', () => {
  const files = readdirSync('agents')
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
  const registered = [...BUILTIN_AGENTS.map((a) => a.replace(/^pr-review:/, '')), 'verifier'].sort();
  assert.deepEqual(files, registered);
});
