import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAll } from '../src/plugins/loader.js';
import {
  companionDispatchCount,
  companionReviewerNames,
  detectClaudePlugins,
  parseInstalledPluginsState,
  parsePluginListOutput,
  recognizedCompanions,
} from '../src/plugins/companions.js';
import { loadConfig } from '../src/config.js';

test('loadAll — launching below the Git root keeps root config and scoped skills inside the checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-subdir-root-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-subdir-home-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
    const subdir = join(root, 'src');
    const instructions = join(root, '.github', 'instructions');
    mkdirSync(subdir, { recursive: true });
    mkdirSync(instructions, { recursive: true });
    writeFileSync(join(root, '.pr-review.yaml'), 'language: pt-BR\n');
    writeFileSync(join(instructions, 'auth.instructions.md'), '---\napplies_to: ["src/**"]\n---\nAuth rule.\n');

    const { config } = loadConfig({
      cwd: subdir,
      repoRoot: root,
      homeOverride: home,
      cliOverrides: { autodiscover: false, skills: ['../.github/instructions/auth.instructions.md'] },
    });
    const loaded = loadAll({ cwd: subdir, config, skillsOnly: true, home, changedPaths: ['src/app.ts'] });

    assert.equal(config.language, 'pt-BR');
    assert.equal(config.skills[0], join(instructions, 'auth.instructions.md'));
    assert.equal(loaded.skills.filter((skill) => skill.name === 'auth').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

function tmpRepoWithSkills(): { cwd: string; home: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  const skillsDir = join(cwd, 'team-skills');
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
      cliOverrides: { autodiscover: false, skillsDirs: [join(cwd, 'team-skills')] },
    });
    const { skills } = loadAll({ cwd, config, skillsOnly: true });
    const names = skills.map((s) => s.name).sort();
    assert.deepEqual(names, ['domain-glossary', 'team-rules']);
    const team = skills.find((s) => s.name === 'team-rules')!;
    assert.deepEqual(team.appliesTo, ['**/*.ts']);
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
      cliOverrides: { autodiscover: false, skillsDirs: [join(cwd, 'team-skills'), extraDir] },
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

test('loadAll — equivalent mirrored rules dedupe without a collision warning', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  const captured: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  try {
    const claudeRules = join(cwd, '.claude', 'rules');
    const githubInstructions = join(cwd, '.github', 'instructions');
    mkdirSync(claudeRules, { recursive: true });
    mkdirSync(githubInstructions, { recursive: true });
    writeFileSync(join(claudeRules, 'auth.md'), '---\npaths: ["src/**"]\n---\n# Auth\nSame body.\n');
    writeFileSync(join(githubInstructions, 'auth.instructions.md'), '---\napplyTo: ["src/**"]\n---\n# Auth\nSame body.\n');
    (process.stderr as unknown as { write: (text: string) => boolean }).write = (text: string) => {
      captured.push(String(text));
      return true;
    };
    const { config } = loadConfig({ cwd, homeOverride: home });
    const set = loadAll({ cwd, config, skillsOnly: true, home });
    assert.equal(set.skills.filter((skill) => skill.name === 'auth').length, 1);
    assert.ok(!captured.some((line) => line.includes("skill name 'auth' collides")));
  } finally {
    process.stderr.write = originalWrite;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadAll — a changed later mirror cannot evict the unchanged trusted rule', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const claudeRules = join(cwd, '.claude', 'rules');
    const githubInstructions = join(cwd, '.github', 'instructions');
    mkdirSync(claudeRules, { recursive: true });
    mkdirSync(githubInstructions, { recursive: true });
    const trusted = join(claudeRules, 'auth.md');
    const changed = join(githubInstructions, 'auth.instructions.md');
    writeFileSync(trusted, '---\npaths: ["src/**"]\n---\n# Auth\nTrusted body.\n');
    writeFileSync(changed, '---\napplyTo: ["src/**"]\n---\n# Auth\nChanged body.\n');
    const { config } = loadConfig({ cwd, homeOverride: home });
    const set = loadAll({
      cwd,
      config,
      skillsOnly: true,
      home,
      changedPaths: ['.github/instructions/auth.instructions.md'],
    });
    const auth = set.skills.filter((entry) => entry.name === 'auth');
    assert.equal(auth.length, 1);
    assert.ok(auth[0]!.body.includes('Trusted body'));
    assert.deepEqual(set.skippedProjectSkills.map((entry) => entry.source), [changed]);
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

test('companions — installed plugins are separated from recognized dispatches', () => {
  const installed = ['avd', 'pr-review', 'pr-review-toolkit', 'code-review', 'validate'];
  assert.deepEqual(recognizedCompanions(installed), ['pr-review-toolkit', 'code-review']);
  assert.equal(companionDispatchCount(installed), 7);
  assert.equal(companionDispatchCount(['code-review']), 1);
  assert.deepEqual(companionReviewerNames(installed), [
    'companion:pr-review-toolkit/code-reviewer',
    'companion:pr-review-toolkit/code-simplifier',
    'companion:pr-review-toolkit/comment-analyzer',
    'companion:pr-review-toolkit/pr-test-analyzer',
    'companion:pr-review-toolkit/silent-failure-hunter',
    'companion:pr-review-toolkit/type-design-analyzer',
    'companion:code-review',
  ]);
});

test('detectCompanions — a failed registry read is unknown, not confirmed missing', async () => {
  const { detectCompanions } = await import('../src/plugins/companions.js');
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-missing-binary-'));
  try {
    const state = await detectCompanions(join(dir, 'copilot-does-not-exist.exe'), 'copilot');
    assert.ok(state.detectionError);
    assert.deepEqual(state.recognized, []);
    assert.deepEqual(state.missing, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('detectClaudePlugins — an absent registry means no plugins are installed', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-claude-home-'));
  try {
    assert.deepEqual(detectClaudePlugins(home), { installed: [] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('autodiscovery — skills, GitHub instructions, and Claude rules preserve their targeting', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const claudeDir = join(cwd, '.claude', 'skills');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'generic-agent-skill.md'), '---\ndescription: video editing helper\n---\nNot a review rule.\n');
    writeFileSync(
      join(claudeDir, 'targeted-rule.md'),
      '---\ndescription: api rules\napplies_to: ["**/*.ts"]\n---\nA real review rule.\n',
    );
    const githubInstructions = join(cwd, '.github', 'instructions');
    const claudeRules = join(cwd, '.claude', 'rules');
    mkdirSync(githubInstructions, { recursive: true });
    mkdirSync(claudeRules, { recursive: true });
    writeFileSync(
      join(githubInstructions, 'auth.instructions.md'),
      '---\napplyTo: "src/**/*Controller.cs"\n---\nAuthorization rule.\n',
    );
    writeFileSync(
      join(claudeRules, 'repo-wide.md'),
      '---\npaths:\n  - "src/**"\n---\nRepository rule.\n',
    );
    const { config } = loadConfig({ cwd, homeOverride: home });
    const { skills, catalog } = loadAll({ cwd, config, skillsOnly: true, home });
    assert.deepEqual(skills.map((s) => s.name).sort(), ['auth', 'repo-wide', 'targeted-rule']);
    assert.deepEqual(skills.find((s) => s.name === 'auth')?.appliesTo, ['src/**/*Controller.cs']);
    assert.deepEqual(skills.find((s) => s.name === 'repo-wide')?.appliesTo, ['src/**']);
    assert.deepEqual(catalog.map((s) => s.name), ['generic-agent-skill'], 'untargeted repo skill → catalog');
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

test('catalog — a name that also exists as a targeted (injected) skill is dropped from the catalog', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const copilotDir = join(cwd, '.copilot', 'skills');
    const claudeDir = join(cwd, '.claude', 'skills');
    mkdirSync(copilotDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    // Same name: targeted (applies_to → injected) in one dir, untargeted in another.
    writeFileSync(join(copilotDir, 'shared-name.md'), '---\ndescription: t\napplies_to: ["**/*.ts"]\n---\nInjected rule body.\n');
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

test('discovery — a symlinked mirror dir does not double-count skills (realpath dedupe)', (context) => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  try {
    const claudeDir = join(cwd, '.claude', 'skills');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'alpha.md'), '---\ndescription: a\n---\nA\n');
    writeFileSync(join(claudeDir, 'beta.md'), '---\ndescription: b\n---\nB\n');
    mkdirSync(join(cwd, '.agents'), { recursive: true });
    // .agents/skills → symlink/junction to .claude/skills (the real double-count trigger).
    try {
      symlinkSync(claudeDir, join(cwd, '.agents', 'skills'), 'junction');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        context.skip(`directory links unavailable: ${code}`);
        return;
      }
      throw err;
    }
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => (captured.push(String(s)), true);
    let catalog;
    try {
      const { config } = loadConfig({ cwd, homeOverride: home });
      catalog = loadAll({ cwd, config, skillsOnly: true, home }).catalog;
    } finally {
      process.stderr.write = orig;
    }
    assert.deepEqual(catalog.map((s) => s.name).sort(), ['alpha', 'beta'], 'each skill appears once');
    const note = captured.find((l) => l.includes('project skill(s)'));
    assert.ok(note && /\b2 project skill/.test(note), `count should be 2 (not 4), got: ${note}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('autodiscovery — linked rule directories are rejected before skill content is read', (context) => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-root-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'pr-review-loader-outside-'));
  try {
    writeFileSync(join(outside, 'outside.md'), '---\napplies_to: ["src/**"]\n---\nOutside content.\n');
    mkdirSync(join(cwd, '.github'), { recursive: true });
    try {
      symlinkSync(outside, join(cwd, '.github', 'instructions'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        context.skip(`directory links unavailable: ${code}`);
        return;
      }
      throw error;
    }
    const { config } = loadConfig({ cwd, homeOverride: home });
    const set = loadAll({ cwd, config, skillsOnly: true, home });
    assert.ok(!set.skills.some((entry) => entry.name === 'outside'));
    assert.ok(!set.catalog.some((entry) => entry.name === 'outside'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('loadAll — skills carry their origin; packSkills load from the home packs root', () => {
  const { cwd, home } = tmpRepoWithSkills();
  try {
    // repo skill dir (auto-discovered)
    mkdirSync(join(cwd, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(cwd, '.claude', 'skills', 'repo-rule.md'), '---\ndescription: r\napplies_to: ["**/*.ts"]\n---\nbody\n');
    // pack checkout under the home packs root
    const packDir = join(home, '.pr-review', 'packs', 'tiny');
    mkdirSync(join(packDir, 'skills', 'aa'), { recursive: true });
    writeFileSync(join(packDir, 'skills', 'aa', 'SKILL.md'), '---\nname: aa\ndescription: pack skill\n---\npack body\n');
    mkdirSync(join(home, '.pr-review'), { recursive: true });
    writeFileSync(join(home, '.pr-review', 'config.yaml'), 'skill_packs:\n  - git: octo/tiny\n    name: tiny\n');

    const { config } = loadConfig({ cwd, homeOverride: home });
    const set = loadAll({ cwd, config, skillsOnly: true, home });

    const repoRule = set.skills.find((s) => s.name === 'repo-rule');
    assert.equal(repoRule?.origin, 'repo');
    assert.deepEqual(set.packSkills.map((s) => s.name), ['tiny/aa']);
    assert.equal(set.packSkills[0]!.origin, 'pack');
    assert.equal(set.packSkills[0]!.pack, 'tiny');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadAll — extra_skills_dirs skills carry origin forced', () => {
  const { cwd, home } = tmpRepoWithSkills();
  try {
    const { config } = loadConfig({ cwd, homeOverride: home });
    config.skillsDirs.push(join(cwd, 'team-skills'));
    const set = loadAll({ cwd, config, skillsOnly: true, home });
    const forced = set.skills.find((s) => s.name === 'team-rules');
    assert.equal(forced?.origin, 'forced');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadAll — explicit skills stay scoped; force skills are unconditional', () => {
  const { cwd, home } = tmpRepoWithSkills();
  try {
    const explicit = join(cwd, 'explicit.md');
    const forced = join(cwd, 'forced.md');
    writeFileSync(explicit, '---\napplies_to: ["**/*.css"]\n---\nExplicit.\n');
    writeFileSync(forced, '---\napplies_to: ["**/*.css"]\n---\nForced.\n');
    const { config } = loadConfig({
      cwd,
      homeOverride: home,
      cliOverrides: { autodiscover: false, skills: [explicit], forceSkills: [forced] },
    });
    const set = loadAll({ cwd, config, skillsOnly: true, home });
    assert.equal(set.skills.find((skill) => skill.name === 'explicit')?.origin, 'explicit');
    assert.equal(set.skills.find((skill) => skill.name === 'forced')?.origin, 'forced');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('loadAll — a non-forced explicit skill outside the checkout is refused before loading', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pr-review-loader-root-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-loader-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'pr-review-loader-outside-'));
  try {
    const outsideSkill = join(outside, 'outside.md');
    writeFileSync(outsideSkill, '---\napplies_to: ["src/**"]\n---\nOutside.\n');
    const { config } = loadConfig({
      cwd,
      homeOverride: home,
      cliOverrides: { autodiscover: false, skills: [outsideSkill] },
    });
    config.skills.push(`${outsideSkill}\nforged warning`);
    const captured: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (value: string) => boolean }).write = (value) => (captured.push(String(value)), true);
    let set;
    try {
      set = loadAll({ cwd, config, skillsOnly: true, home });
    } finally {
      process.stderr.write = original;
    }
    assert.ok(!set.skills.some((entry) => entry.name === 'outside'));
    const warning = captured.find((line) => line.includes('forged warning')) ?? '';
    assert.match(warning, /\\nforged warning/);
    assert.equal(warning.trimEnd().split(/\r?\n/).length, 1, 'configured path cannot inject another log line');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('parseInstalledPluginsJson — malformed or shapeless JSON yields [] (never throws)', async () => {
  const { parseInstalledPluginsJson } = await import('../src/plugins/companions.js');
  assert.deepEqual(parseInstalledPluginsJson('not json at all'), []);
  assert.deepEqual(parseInstalledPluginsJson('null'), []);
  assert.deepEqual(parseInstalledPluginsJson('{"version":2}'), []);
});

test('parseInstalledPluginsState — malformed or shapeless registries are unknown, not empty installs', () => {
  assert.ok(parseInstalledPluginsState('not json').detectionError);
  assert.ok(parseInstalledPluginsState('{"version":2}').detectionError);
  assert.deepEqual(parseInstalledPluginsState('{"plugins":{}}'), { installed: [] });
});
