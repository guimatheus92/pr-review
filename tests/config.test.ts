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

test('loadConfig — includeRepoConfig false keeps global/env/CLI inputs but ignores checkout yaml', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'default_model: global-model\n');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'default_model: untrusted-repo-model\nextra_skills_dirs: [./branch-rules]\n');
    const { config, sources } = loadConfig({
      cwd: tmp,
      homeOverride: home,
      includeRepoConfig: false,
      cliOverrides: { language: 'pt-BR' },
    });
    assert.equal(config.defaultModel, 'global-model');
    assert.equal(config.language, 'pt-BR');
    assert.deepEqual(config.skillsDirs, []);
    assert.equal(sources.repo, undefined);
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

test('loadConfig — hosts: keys are lowercased (detectProvider looks up lowercase hostnames) and unknown providers are warned and skipped', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-'));
  try {
    writeFileSync(join(tmp, '.pr-review.yaml'), 'hosts:\n  GitHub.Corp.COM: github\n  tfs.corp.com: azuredevops\n  bad.com: bitbucket\n');
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.hosts['github.corp.com'], 'github', 'mixed-case yaml key normalized to lowercase');
    assert.equal(config.hosts['GitHub.Corp.COM'], undefined, 'raw mixed-case key is not kept');
    assert.equal(config.hosts['tfs.corp.com'], 'azuredevops');
    assert.equal(config.hosts['bad.com'], undefined, 'unknown provider value dropped, not accepted');
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

// --- skill_packs ---

function cfgDirs(): { tmp: string; home: string } {
  return {
    tmp: mkdtempSync(join(tmpdir(), 'pr-review-cfg-')),
    home: mkdtempSync(join(tmpdir(), 'pr-review-home-')),
  };
}

test('skill_packs — defaults carry the 3 batteries-included packs', () => {
  const { tmp, home } = cfgDirs();
  try {
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.deepEqual(
      config.skillPacks.map((p) => p.name),
      ['awesome-copilot', 'owasp', 'anthropic-cybersecurity'],
    );
    const ac = config.skillPacks[0]!;
    assert.ok(ac.baseline.includes('code-review-generic'));
    assert.equal(config.skillPacks[2]!.mode, 'index');
    assert.ok(config.skillPacks[2]!.exclude.length > 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_packs — yaml REPLACES the list (empty list disables packs entirely)', () => {
  const { tmp, home } = cfgDirs();
  try {
    writeFileSync(join(tmp, '.pr-review.yaml'), 'skill_packs: []\n');
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.deepEqual(config.skillPacks, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_packs — repo yaml replaces the global yaml list entirely', () => {
  const { tmp, home } = cfgDirs();
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'skill_packs:\n  - acme/global-pack\n');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'skill_packs:\n  - acme/repo-pack\n');
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.deepEqual(config.skillPacks.map((p) => p.name), ['repo-pack']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_packs — string shorthand and object entries normalize with defaults', () => {
  const { tmp, home } = cfgDirs();
  try {
    writeFileSync(
      join(tmp, '.pr-review.yaml'),
      [
        'skill_packs:',
        '  - octo/short-pack',
        '  - git: https://gitlab.com/acme/deep.git',
        '    name: deep',
        '    include: ["docs/*.md"]',
        '    mode: index',
        '    baseline: [x]',
        '  - name: broken-no-git',
        '',
      ].join('\n'),
    );
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.skillPacks.length, 2, 'entry without git is dropped with a warning');
    const short = config.skillPacks[0]!;
    assert.deepEqual(
      { name: short.name, git: short.git, include: short.include, exclude: short.exclude, mode: short.mode, baseline: short.baseline },
      { name: 'short-pack', git: 'octo/short-pack', include: ['**/SKILL.md'], exclude: [], mode: 'auto', baseline: [] },
    );
    const deep = config.skillPacks[1]!;
    assert.equal(deep.mode, 'index');
    assert.deepEqual(deep.include, ['docs/*.md']);
    assert.deepEqual(deep.baseline, ['x']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_packs — other list keys still PUSH across levels (regression)', () => {
  const { tmp, home } = cfgDirs();
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'extra_skills_dirs:\n  - ./global-skills\n');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'extra_skills_dirs:\n  - ./repo-skills\n');
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.skillsDirs.length, 2, 'skillsDirs accumulates, unlike skillPacks');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});


test('skill_packs — null (empty key) and scalar values warn and are ignored, never crash', () => {
  const { tmp, home } = cfgDirs();
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    writeFileSync(join(tmp, '.pr-review.yaml'), 'skill_packs:\n  # - github/awesome-copilot\n');
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.skillPacks.length, 3, 'null key keeps the defaults instead of crashing');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'skill_packs: github/awesome-copilot\n');
    const { config: scalar } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(scalar.skillPacks.length, 3);
    assert.ok(lines.some((l) => l.includes('skill_packs must be a list')));
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('skill_packs — duplicate pack names: first wins with a warning (no shared checkout aliasing)', () => {
  const { tmp, home } = cfgDirs();
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    lines.push(s);
    return true;
  };
  try {
    writeFileSync(join(tmp, '.pr-review.yaml'), 'skill_packs:\n  - alpha/skills\n  - beta/skills\n');
    const { config } = loadConfig({ cwd: tmp, homeOverride: home });
    assert.equal(config.skillPacks.length, 1);
    assert.equal(config.skillPacks[0]!.git, 'alpha/skills');
    assert.ok(lines.some((l) => l.includes("duplicate skill pack name 'skills'")));
  } finally {
    (process.stderr as unknown as { write: typeof orig }).write = orig;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadConfig — a checkout-local hosts: map never merges, with or without repo config', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pr-review-cfg-hosts-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-home-hosts-'));
  try {
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'hosts:\n  global.example: github\n');
    writeFileSync(join(tmp, '.pr-review.yaml'), 'language: pt-BR\nhosts:\n  global.example: gitlab\n  repo-only.example: gitlab\n');
    const merged = loadConfig({ cwd: tmp, repoRoot: tmp, homeOverride: home }).config;
    assert.equal(merged.language, 'pt-BR', 'other repo keys still merge');
    assert.deepEqual(merged.hosts, { 'global.example': 'github' }, 'repo hosts neither add nor override');
    const trusted = loadConfig({ cwd: tmp, repoRoot: tmp, homeOverride: home, includeRepoConfig: false }).config;
    assert.deepEqual(trusted.hosts, { 'global.example': 'github' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
