import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, autodiscoveryPaths } from '../src/config.js';

test('loadConfig — defaults when no files or flags', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  try {
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.defaultModel, 'claude-opus-4.8');
    assert.equal(config.autodiscover, true);
    assert.equal(config.dedupeMode, 'strict');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig — repo yaml overrides global yaml', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'default_model: gpt-5\n');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'default_model: claude-sonnet-4.6\n');
    const { config, sources } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.defaultModel, 'claude-sonnet-4.6');
    assert.ok(sources.global);
    assert.ok(sources.repo);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig — CLI flag overrides everything', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  try {
    writeFileSync(join(tmp, '.pr-review.yaml'), 'default_model: claude-sonnet-4.6\n');
    const { config } = loadConfig({
      cwd: tmp,
      homeOverride: home,
      cliOverrides: { defaultModel: 'gpt-5.4', autodiscover: false },
    });
    assert.equal(config.defaultModel, 'gpt-5.4');
    assert.equal(config.autodiscover, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig — env var overrides defaults', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  const prior = process.env.PR_REVIEW_DEFAULT_MODEL;
  try {
    process.env.PR_REVIEW_DEFAULT_MODEL = 'env-set-model';
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.defaultModel, 'env-set-model');
  } finally {
    if (prior === undefined) delete process.env.PR_REVIEW_DEFAULT_MODEL;
    else process.env.PR_REVIEW_DEFAULT_MODEL = prior;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig — env var overrides yaml files (defaults < global < repo < env < flags)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  const prior = process.env.PR_REVIEW_DEFAULT_MODEL;
  try {
    writeFileSync(join(tmp, '.pr-review.yaml'), 'default_model: repo-model\n');
    process.env.PR_REVIEW_DEFAULT_MODEL = 'env-set-model';
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.defaultModel, 'env-set-model');
    const { config: withFlag } = loadConfig({
      cwd: tmp,
      homeOverride: home,
      cliOverrides: { defaultModel: 'flag-model' },
    });
    assert.equal(withFlag.defaultModel, 'flag-model');
  } finally {
    if (prior === undefined) delete process.env.PR_REVIEW_DEFAULT_MODEL;
    else process.env.PR_REVIEW_DEFAULT_MODEL = prior;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig — language: default en, yaml key, env override', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  const prior = process.env.PR_REVIEW_LANG;
  try {
    const { config: defaults } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(defaults.language, 'en');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'language: pt-BR\n');
    const { config: fromYaml } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(fromYaml.language, 'pt-BR');
    process.env.PR_REVIEW_LANG = 'es';
    const { config: fromEnv } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(fromEnv.language, 'es');
  } finally {
    if (prior === undefined) delete process.env.PR_REVIEW_LANG;
    else process.env.PR_REVIEW_LANG = prior;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('autodiscoveryPaths — built-in reviewers are agents (no reviewer dirs auto-discovered); skills read from the tool dirs', () => {
  const paths = autodiscoveryPaths('/repo', '/home/user');
  assert.equal(paths.repoReviewers.length, 0);
  assert.equal(paths.personalReviewers.length, 0);
  // Skills are read from where the agent tools keep them — no .pr-review/skills concept.
  assert.ok(!paths.repoSkills.some((p) => /\.pr-review[\/\\]skills$/.test(p)), 'no .pr-review/skills');
  assert.ok(!paths.personalSkills.some((p) => /\.pr-review[\/\\]skills$/.test(p)), 'no home .pr-review/skills');
  assert.ok(paths.repoSkills.some((p) => /\.claude[\/\\]skills$/.test(p)));
  assert.ok(paths.repoSkills.some((p) => /\.copilot[\/\\]skills$/.test(p)));
  assert.ok(paths.repoSkills.some((p) => /\.github[\/\\]skills$/.test(p)));
  assert.ok(paths.repoSkills.some((p) => /\.agents[\/\\]skills$/.test(p)));
  assert.ok(paths.personalSkills.some((p) => /\.claude[\/\\]skills$/.test(p)));
  assert.ok(paths.personalSkills.some((p) => /\.copilot[\/\\]skills$/.test(p)));
});

