import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseFrontmatter } from '../src/plugins/builtin.js';

test('parseFrontmatter — basic YAML frontmatter', () => {
  const raw = `---
description: A test reviewer
applies_to:
  - "**/*.ts"
model: claude-opus-4.8
---

# Body content here
This is the body.`;
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.description, 'A test reviewer');
  assert.deepEqual(meta.applies_to, ['**/*.ts']);
  assert.equal(meta.model, 'claude-opus-4.8');
  assert.match(body, /^# Body content here/);
});

test('parseFrontmatter — no frontmatter returns whole body', () => {
  const raw = `# Just markdown content
No frontmatter at all.`;
  const { meta, body } = parseFrontmatter(raw);
  assert.deepEqual(meta, {});
  assert.equal(body, raw);
});

test('parseFrontmatter — invalid YAML falls through', () => {
  const raw = `---
invalid: : : yaml
---

body`;
  const { meta } = parseFrontmatter(raw);
  // yaml parser may or may not throw; we just check it doesn't crash
  assert.ok(typeof meta === 'object');
});

test('parseFrontmatter — handles CRLF line endings', () => {
  const raw = `---\r\ndescription: Windows file\r\n---\r\n\r\nbody`;
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.description, 'Windows file');
  assert.match(body, /body/);
});

test('parseFrontmatter — supports inject_into key for skills', () => {
  const raw = `---
description: A skill
applies_to: ["**/*Controller.cs"]
inject_into: [security, architecture]
---

skill body`;
  const { meta } = parseFrontmatter(raw);
  assert.deepEqual(meta.inject_into, ['security', 'architecture']);
});
