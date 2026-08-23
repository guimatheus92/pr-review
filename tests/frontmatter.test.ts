import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkillFile, normalizeSkillName, parseFrontmatter, parseGlobList } from '../src/plugins/builtin.js';

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

test('parseFrontmatter — UTF-8 BOM before the frontmatter fence is stripped', () => {
  const raw = '﻿---\ndescription: bom test\ninject_into: [quality]\n---\nBody.\n';
  const { meta, body } = parseFrontmatter(raw);
  assert.equal(meta.description, 'bom test');
  assert.deepEqual(meta.inject_into, ['quality']);
  assert.equal(body.trim(), 'Body.');
});

// --- pack-format support: applyTo CSV, tags, frontmatter name, heading fallback ---

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-fm-'));
  const path = join(dir, name);
  mkdirSync(join(dir), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

test('parseGlobList — CSV string with spaces, list, and junk', () => {
  assert.deepEqual(parseGlobList('**/*.go,**/go.mod, **/go.sum'), ['**/*.go', '**/go.mod', '**/go.sum']);
  assert.deepEqual(parseGlobList(['**/*.ts', ' **/*.tsx ']), ['**/*.ts', '**/*.tsx']);
  assert.deepEqual(parseGlobList(undefined), []);
  assert.deepEqual(parseGlobList(42), []);
});

test('normalizeSkillName — pack filename conventions fold to agentskills shape', () => {
  assert.equal(normalizeSkillName('go.instructions'), 'go');
  assert.equal(normalizeSkillName('Input_Validation_Cheat_Sheet'.toLowerCase()), 'input-validation');
  assert.equal(normalizeSkillName('Input_Validation_Cheat_Sheet'), 'input-validation');
  assert.equal(normalizeSkillName('plain-skill'), 'plain-skill');
});

test('loadSkillFile — applyTo CSV string routes as applies_to', () => {
  const path = tmpFile('go.instructions.md', [
    '---',
    "description: 'Go instructions'",
    "applyTo: '**/*.go,**/go.mod,**/go.sum'",
    '---',
    '# Go',
  ].join('\n'));
  const skill = loadSkillFile(path);
  assert.equal(skill.name, 'go');
  assert.deepEqual(skill.appliesTo, ['**/*.go', '**/go.mod', '**/go.sum']);
});

test('loadSkillFile — frontmatter name wins over the filename', () => {
  const path = tmpFile('whatever.md', ['---', 'name: github-actions-hardening', 'description: x', '---', 'body'].join('\n'));
  assert.equal(loadSkillFile(path).name, 'github-actions-hardening');
});

test('loadSkillFile — no frontmatter: description falls back to the first heading', () => {
  const path = tmpFile('Nodejs_Security_Cheat_Sheet.md', '# NodeJS Security Cheat Sheet\n\n## Introduction\ntext');
  const skill = loadSkillFile(path);
  assert.equal(skill.name, 'nodejs-security');
  assert.equal(skill.description, 'NodeJS Security Cheat Sheet');
  assert.deepEqual(skill.appliesTo, []);
});

test('loadSkillFile — tags frontmatter is parsed', () => {
  const path = tmpFile('k8s.md', ['---', 'description: x', 'tags: [kubernetes, rbac]', '---', 'body'].join('\n'));
  assert.deepEqual(loadSkillFile(path).tags, ['kubernetes', 'rbac']);
});
