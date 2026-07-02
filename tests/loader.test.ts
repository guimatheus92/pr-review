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

test('autodiscovery — untargeted skills from generic shared dirs are skipped; .pr-review/skills loads everything', () => {
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
    const { skills } = loadAll({ cwd, config, skillsOnly: true, home });
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['targeted-rule', 'untargeted-pr']);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
