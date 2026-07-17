import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from '../src/plugins/loader.js';
import { parsePluginListOutput } from '../src/plugins/companions.js';
import { loadConfig } from '../src/config.js';

function tmpRepoWithSkills(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  const skillsDir = join(cwd, '.pr-review', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(skillsDir, 'team-rules.md'),
    '---\ndescription: team rules\napplies_to: ["**/*.ts"]\ninject_into: [security]\n---\nRule body.\n',
  );
  // SKILL.md directory form: named after the directory, no recursion below it
  const skillDir = join(skillsDir, 'domain-glossary');
  mkdirSync(join(skillDir, 'nested'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\ndescription: glossary\n---\nGlossary body.\n');
  writeFileSync(join(skillDir, 'nested', 'ignored.md'), 'should not be loaded\n');
  return { cwd, home };
}

test('loadAll — discovers flat .md and SKILL.md dirs, parses targeting frontmatter', () => {
  const { cwd, home } = tmpRepoWithSkills();
  try {
    // autodiscover off so the developer's real ~/.claude/skills don't leak into the test
    const { config } = loadConfig({
      cwd,
      homeOverride: home,
      cliOverrides: { autodiscover: false, skillsDirs: [join(cwd, '.pr-review', 'skills')] },
    });
    const { skills } = loadAll({ cwd, config, skillsOnly: true });
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['domain-glossary', 'team-rules']);
    const team = skills.find((s) => s.name === 'team-rules')!;
    assert.deepEqual(team.appliesTo, ['**/*.ts']);
    assert.deepEqual(team.injectInto, ['security']);
    assert.ok(!skills.some((s) => s.name === 'ignored'), 'files under a SKILL.md dir are not loaded');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadAll — skill name collision: later wins', () => {
  const { cwd, home } = tmpRepoWithSkills();
  try {
    const extraDir = join(cwd, 'extra-skills');
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, 'team-rules.md'), 'Overriding body.\n');
    const { config } = loadConfig({
      cwd,
      homeOverride: home,
      cliOverrides: { autodiscover: false, skillsDirs: [join(cwd, '.pr-review', 'skills'), extraDir] },
    });
    const { skills } = loadAll({ cwd, config, skillsOnly: true });
    const team = skills.filter((s) => s.name === 'team-rules');
    assert.equal(team.length, 1);
    assert.ok(team[0]!.body.includes('Overriding body'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('parsePluginListOutput — bullet and dash formats, versioned names', () => {
  const stdout = [
    'Installed plugins:',
    '  • pr-review-toolkit@claude-code-plugins (6 agents)',
    '  - code-review@claude-code-plugins',
    '  * some-plugin extra text',
    'not a plugin line',
  ].join('\n');
  const installed = parsePluginListOutput(stdout);
  assert.deepEqual(installed, ['pr-review-toolkit', 'code-review', 'some-plugin']);
});

test('parseInstalledPluginsJson — claude runtime plugin detection', async () => {
  const { parseInstalledPluginsJson } = await import('../src/plugins/companions.js');
  const raw = JSON.stringify({
    version: 2,
    plugins: {
      'pr-review-toolkit@claude-plugins-official': [{ scope: 'user' }],
      'code-review@claude-plugins-official': [{ scope: 'user' }],
      'codex@openai-codex': [{ scope: 'user' }],
    },
  });
  const names = parseInstalledPluginsJson(raw);
  assert.deepEqual(names.sort(), ['code-review', 'codex', 'pr-review-toolkit']);
});

test('autodiscovery — untargeted repo shared-dir skills go to catalog; .pr-review and targeted skills still inject', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const prDir = join(cwd, '.pr-review', 'skills');
    const claudeDir = join(cwd, '.claude', 'skills');
    mkdirSync(prDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(prDir, 'untargeted-pr.md'), 'Review rule with no frontmatter.\n');
    writeFileSync(join(claudeDir, 'generic-agent-skill.md'), '---\ndescription: video editing helper\n---\nNot a review rule.\n');
    writeFileSync(
      join(claudeDir, 'targeted-rule.md'),
      '---\ndescription: api rules\napplies_to: ["**/*.ts"]\n---\nA real review rule.\n',
    );
    const { config } = loadConfig({ cwd, homeOverride: home });
    const { skills, catalog } = loadAll({ cwd, config, skillsOnly: true, home });
    assert.deepEqual(skills.map((s) => s.name).sort(), ['targeted-rule', 'untargeted-pr']);
    assert.deepEqual(catalog.map((s) => s.name), ['generic-agent-skill']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('autodiscovery — untargeted HOME shared-dir skills are skipped, not cataloged', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const homeClaude = join(home, '.claude', 'skills');
    mkdirSync(homeClaude, { recursive: true });
    writeFileSync(join(homeClaude, 'personal-helper.md'), '---\ndescription: personal design helper\n---\nNot a review rule.\n');
    const { config } = loadConfig({ cwd, homeOverride: home });
    const { skills, catalog } = loadAll({ cwd, config, skillsOnly: true, home });
    assert.ok(!skills.some((s) => s.name === 'personal-helper'), 'home untargeted not injected');
    assert.ok(!catalog.some((s) => s.name === 'personal-helper'), 'home untargeted not cataloged');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('catalog — a name that also exists as an injected skill is dropped from the catalog', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const prDir = join(cwd, '.pr-review', 'skills');
    const claudeDir = join(cwd, '.claude', 'skills');
    mkdirSync(prDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    // Same name in both: injected via .pr-review (by location), untargeted in .claude.
    writeFileSync(join(prDir, 'shared-name.md'), 'Injected rule body.\n');
    writeFileSync(join(claudeDir, 'shared-name.md'), '---\ndescription: dup\n---\nCatalog body.\n');
    const { config } = loadConfig({ cwd, homeOverride: home });
    const { skills, catalog } = loadAll({ cwd, config, skillsOnly: true, home });
    assert.equal(skills.filter((s) => s.name === 'shared-name').length, 1, 'injected once');
    assert.ok(!catalog.some((s) => s.name === 'shared-name'), 'injected wins; not duplicated in catalog');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('parseInstalledPluginsJson — malformed or shapeless JSON yields [] (never throws)', async () => {
  const { parseInstalledPluginsJson } = await import('../src/plugins/companions.js');
  assert.deepEqual(parseInstalledPluginsJson('not json at all'), []);
  assert.deepEqual(parseInstalledPluginsJson('null'), []);
  assert.deepEqual(parseInstalledPluginsJson('{"version":2}'), []);
});
