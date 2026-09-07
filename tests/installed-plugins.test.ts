import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInstalledPlugins, discoverMcpCapabilities, launchesRepoCode } from '../src/plugins/installed.js';
import { readCapabilityUsage } from '../src/commands/review.js';

function seedPlugin(home: string, marketplace: string, id: string, over: Record<string, unknown> = {}): string {
  const root = join(home, '.copilot', 'installed-plugins', marketplace, id);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'review-stack'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: id, version: '1.2.3', skills: ['./skills/review-stack'], mcpServers: { [`${id}-mcp`]: {} }, ...over }),
  );
  writeFileSync(
    join(root, 'skills', 'review-stack', 'SKILL.md'),
    `---\nname: review-stack\ndescription: Review ${id} changes and validate contracts.\n---\n# ${id} review\n`,
  );
  return root;
}

/** Claude Code nests an extra <version> level and records installPath in its manifest. */
function seedClaudePlugin(home: string, marketplace: string, id: string, version: string): string {
  const root = join(home, '.claude', 'plugins', 'cache', marketplace, id, version);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'skills', 'review-stack'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: id, version, skills: ['./skills/review-stack'], mcpServers: { [`${id}-mcp`]: {} } }),
  );
  writeFileSync(
    join(root, 'skills', 'review-stack', 'SKILL.md'),
    `---\nname: review-stack\ndescription: Review ${id} changes and validate contracts.\n---\n# ${id} review\n`,
  );
  return root;
}

test('discoverInstalledPlugins — Claude Code installs are discovered, not just Copilot ones', () => {
  // pr-review runs under Copilot CLI AND Claude Code; a plugin installed in either
  // host must be found. Claude keeps several versions side by side, so the version
  // is read from installed_plugins.json rather than guessed by walking the cache.
  const home = mkdtempSync(join(tmpdir(), 'pr-review-claude-home-'));
  try {
    seedPlugin(home, 'market-a', 'copilot-tools');
    const live = seedClaudePlugin(home, 'market-c', 'claude-tools', '2.0.0');
    seedClaudePlugin(home, 'market-c', 'claude-tools', '1.0.0-stale');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { 'claude-tools@market-c': [{ scope: 'user', installPath: live, version: '2.0.0' }] },
      }),
    );
    const plugins = discoverInstalledPlugins(home);
    assert.deepEqual(plugins.map((plugin) => plugin.id), ['claude-tools', 'copilot-tools']);
    const claudeTools = plugins.find((plugin) => plugin.id === 'claude-tools');
    assert.equal(claudeTools?.version, '2.0.0', 'the installed version wins over the stale sibling');
    assert.deepEqual(claudeTools?.skills.map((skill) => skill.name), ['claude-tools/review-stack']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverInstalledPlugins — a Copilot-only host is normal, not an error', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-copilot-only-'));
  try {
    seedPlugin(home, 'market-a', 'copilot-tools');
    assert.deepEqual(discoverInstalledPlugins(home).map((plugin) => plugin.id), ['copilot-tools']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverMcpCapabilities — a repo MCP server that launches checkout code is refused', () => {
  // Refusing only a CHANGED .mcp.json is not enough: the config can be untouched while
  // the PR rewrites the script it points at, and the checkout is already at that head.
  const repoRoot = mkdtempSync(join(tmpdir(), 'pr-review-mcp-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-mcp-home-'));
  try {
    writeFileSync(
      join(repoRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'in-repo': { command: 'node', args: ['./scripts/mcp-server.js'] },
          external: { command: 'npx', args: ['-y', '@scope/mcp'] },
        },
      }),
    );
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts', 'mcp-server.js'), 'module.exports = {};');
    // The PR does not touch .mcp.json at all — only the script it launches.
    const result = discoverMcpCapabilities({
      repoRoot,
      home,
      plugins: [],
      changedPaths: ['scripts/mcp-server.js'],
    });
    assert.deepEqual(Object.keys(result.trustedRepoConfig?.mcpServers ?? {}), ['external']);
    assert.deepEqual(result.servers.filter((s) => s.source === 'repo').map((s) => s.name), ['external']);
    assert.ok(result.warnings.some((w) => w.includes('launches code from the reviewed checkout')));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('launchesRepoCode — in-repo launch paths are caught, external tooling is not', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'pr-review-launch-'));
  try {
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(join(repoRoot, 'scripts', 'mcp-server.js'), 'module.exports = {};');
    const inRepo = [
      { command: 'node', args: ['./scripts/mcp-server.js'] },
      { command: 'node', args: ['scripts/mcp-server.js'] },
      { command: join(repoRoot, 'bin', 'server') },
      { command: 'node', args: ['--x'], env: { PLUGIN: './plugins/evil.js' } },
      { command: 'node', cwd: repoRoot },
    ];
    for (const definition of inRepo) {
      assert.equal(launchesRepoCode(definition, repoRoot), true, JSON.stringify(definition));
    }
    const external = [
      { command: 'npx', args: ['-y', '@scope/mcp'] },
      { command: 'docker', args: ['run', 'ghcr.io/acme/mcp:1'] },
      { command: 'uvx', args: ['mcp-server-git'] },
      { command: 'root-bicep' },
      { command: 'node', args: ['--experimental-x'] },
    ];
    for (const definition of external) {
      assert.equal(launchesRepoCode(definition, repoRoot), false, JSON.stringify(definition));
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('discoverInstalledPlugins — loads namespaced skills and MCPs from generic plugin manifests', () => {
  const home = mkdtempSync(join(tmpdir(), 'pr-review-installed-home-'));
  try {
    const outside = join(home, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '---\nname: escaped\n---\nNever load this.\n');
    seedPlugin(home, 'market-a', 'alpha-tools', {
      skills: ['./skills/review-stack', '../../../../outside/SKILL.md'],
    });
    seedPlugin(home, 'market-duplicate', 'alpha-tools');
    seedPlugin(home, 'market-b', 'beta-tools');
    seedPlugin(home, 'self', 'pr-review');
    const plugins = discoverInstalledPlugins(home);
    assert.deepEqual(plugins.map((plugin) => plugin.id), ['alpha-tools', 'beta-tools']);
    assert.equal(plugins.filter((plugin) => plugin.id === 'alpha-tools').length, 1);
    assert.deepEqual(plugins[0]?.skills.map((skill) => skill.name), ['alpha-tools/review-stack']);
    assert.deepEqual(plugins[0]?.skills[0]?.mcpServers, ['alpha-tools-mcp']);
    assert.equal(plugins[0]?.skills[0]?.origin, 'plugin');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discoverMcpCapabilities — merges trusted repo, user, and plugin names; changed repo config is ignored', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-mcp-root-'));
  const home = mkdtempSync(join(tmpdir(), 'pr-review-mcp-home-'));
  try {
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { bicep: { command: 'root-bicep' } } }));
    mkdirSync(join(root, '.vscode'), { recursive: true });
    writeFileSync(join(root, '.vscode', 'mcp.json'), JSON.stringify({ servers: {
      bicep: { command: 'vscode-bicep' },
      fabric: { command: 'vscode-fabric' },
    } }));
    mkdirSync(join(home, '.copilot'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: { ado: {} } }));
    seedPlugin(home, 'market-a', 'alpha-tools');
    const plugins = discoverInstalledPlugins(home);
    const trusted = discoverMcpCapabilities({ repoRoot: root, home, plugins, changedPaths: ['src/app.ts'] });
    assert.deepEqual(trusted.servers.map((server) => `${server.source}:${server.name}`).sort(), [
      'plugin:alpha-tools:alpha-tools-mcp',
      'repo:bicep',
      'repo:fabric',
      'user:ado',
    ]);
    assert.deepEqual(trusted.trustedRepoConfig, { mcpServers: {
      bicep: { command: 'root-bicep' },
      fabric: { command: 'vscode-fabric' },
    } });

    const changed = discoverMcpCapabilities({ repoRoot: root, home, plugins, changedPaths: ['.mcp.json'] });
    assert.ok(!changed.servers.some((server) => server.source === 'repo'));
    assert.equal(changed.trustedRepoConfig, undefined);
    assert.match(changed.warnings[0] ?? '', /ignored as untrusted/);

    const unrelatedCheckout = discoverMcpCapabilities({ home, plugins, changedPaths: ['src/app.ts'] });
    assert.ok(!unrelatedCheckout.servers.some((server) => server.source === 'repo'));
    assert.equal(unrelatedCheckout.trustedRepoConfig, undefined);
    assert.ok(unrelatedCheckout.servers.some((server) => server.source === 'user'));
    assert.ok(unrelatedCheckout.servers.some((server) => server.source === 'plugin:alpha-tools'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('readCapabilityUsage — a claimed MCP call is recorded verbatim AND flagged; a missing sidecar degrades', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-usage-'));
  try {
    const valid = join(root, 'valid.json');
    writeFileSync(valid, JSON.stringify({
      reviewer: 'ignored-spoof',
      available: ['model-inspector', 'video-analyzer'],
      attempted: ['model-inspector'],
      used: ['model-inspector'],
      notes: 'Read-only validation completed.',
    }));
    const result = readCapabilityUsage({
      'plugin/model-review': valid,
      'plugin/missing-review': join(root, 'missing.json'),
    });
    // The raw claim is still archived unchanged — the audit annotates evidence, never edits it.
    assert.deepEqual(result.usage, [{
      reviewer: 'plugin/model-review',
      available: ['model-inspector', 'video-analyzer'],
      attempted: ['model-inspector'],
      used: ['model-inspector'],
      notes: 'Read-only validation completed.',
    }]);
    assert.equal(result.warnings.length, 2);
    const claim = result.warnings.find((warning) => warning.includes('reported MCP servers'));
    assert.ok(claim, 'a non-empty sidecar must raise a warning of its own');
    // safeSummaryValue escapes every sidecar-supplied string before it reaches the summary.
    assert.match(claim, /plugin&#47;model&#45;review/, 'the warning names the pass, escaped');
    assert.match(
      claim,
      /available: &#34;model&#45;inspector&#34;, &#34;video&#45;analyzer&#34;/,
      'every server in the field is listed, comma-separated, each escaped',
    );
    assert.match(claim, /attempted: .*model&#45;inspector/);
    assert.match(claim, /used: .*model&#45;inspector/);
    assert.match(claim, /denial leak or fabricated evidence, unverified/);
    assert.equal(result.claims.length, 1, 'only the MCP claim gets a console twin, not the missing sidecar');
    assert.match(
      result.claims[0] ?? '',
      /installed-plugin pass plugin\/model-review .*available: model-inspector, video-analyzer/,
      'the console form is plain text — the server names must stay greppable',
    );
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes('plugin&#47;missing&#45;review') && /produced no MCP usage evidence/.test(warning)),
      'the missing-evidence warning still names which pass was missing',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCapabilityUsage — the all-empty sidecar the denial produces is silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-clean-'));
  try {
    const clean = join(root, 'clean.json');
    writeFileSync(clean, JSON.stringify({
      reviewer: 'plugin/model-review',
      available: [],
      attempted: [],
      used: [],
      notes: 'No mcp__* tool was callable; nothing attempted.',
    }));
    const result = readCapabilityUsage({ 'plugin/model-review': clean });
    assert.deepEqual(result.warnings, [], 'the healthy path must not warn — a noisy alarm gets trained away');
    assert.deepEqual(result.claims, []);
    assert.equal(result.usage.length, 1);
    assert.equal(result.usage[0]?.notes, 'No mcp__* tool was callable; nothing attempted.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCapabilityUsage — a sidecar naming hundreds of servers cannot flood the summary', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-flood-'));
  try {
    const flood = join(root, 'flood.json');
    // The sidecar is written by a dispatched agent, so its server list is untrusted input on its
    // way into the Degraded block. safeSummaryValue escapes each name but does not bound the list.
    const names = Array.from({ length: 300 }, (_, index) => `server-${index}`);
    writeFileSync(flood, JSON.stringify({
      reviewer: 'plugin/model-review', available: names, attempted: [], used: [], notes: '',
    }));
    const result = readCapabilityUsage({ 'plugin/model-review': flood });
    assert.equal(result.warnings.length, 1);
    const warning = result.warnings[0] ?? '';
    assert.match(warning, /\(\+290 more\)/, 'the count of omitted servers is reported, never silently dropped');
    assert.ok(!warning.includes('server-10,'), 'the list stops at the cap');
    assert.ok(warning.length < 1000, `one Degraded bullet stayed bounded (was ${warning.length})`);
    assert.equal(result.usage[0]?.available.length, 300, 'the archived evidence is still complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCapabilityUsage — one absurdly long server name cannot blow up the warning', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-longname-'));
  try {
    const path = join(root, 'long.json');
    writeFileSync(path, JSON.stringify({
      reviewer: 'plugin/model-review', available: ['x'.repeat(5000)], attempted: [], used: [], notes: '',
    }));
    const result = readCapabilityUsage({ 'plugin/model-review': path });
    assert.equal(result.warnings.length, 1);
    assert.ok((result.warnings[0] ?? '').length < 1000, 'per-name truncation, not just a per-list cap');
    assert.equal(result.usage[0]?.available[0]?.length, 5000, 'the archived evidence is still complete');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCapabilityUsage — a server name carrying control characters cannot forge a console line', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-inject-'));
  try {
    const path = join(root, 'inject.json');
    // Server names come from a dispatched agent, and the console form drops safeSummaryValue's
    // entity escaping to stay greppable — so the newline defence there is printable(), not escaping.
    writeFileSync(path, JSON.stringify({
      reviewer: 'plugin/model-review',
      available: ['ok\n[mcp] FORGED: denial held, nothing to see\r\u0007'],
      attempted: [],
      used: [],
      notes: '',
    }));
    const result = readCapabilityUsage({ 'plugin/model-review': path });
    assert.equal(result.claims.length, 1);
    assert.equal(result.warnings.length, 1);
    for (const [form, line] of [['console', result.claims[0] ?? ''], ['summary', result.warnings[0] ?? '']] as const) {
      assert.doesNotMatch(line, /[\u0000-\u001f\u007f]/, `the ${form} form must stay one line — a second line reads as a separate log record`);
    }
    assert.match(result.claims[0] ?? '', /available: ok\[mcp\] FORGED/, 'the text survives, inline and attributed');
    assert.equal(result.usage[0]?.available[0]?.includes('\n'), true, 'the archived evidence keeps the raw bytes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readCapabilityUsage — a leak reported only in available still warns', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-leak-'));
  try {
    const leak = join(root, 'leak.json');
    // The brief tells a pass that finds a callable mcp__* tool to name it in available and to
    // fill used only after a successful result — so this is the shape a real leak arrives in.
    writeFileSync(leak, JSON.stringify({
      reviewer: 'plugin/model-review',
      available: ['video-analyzer'],
      attempted: [],
      used: [],
      notes: 'mcp__video-analyzer__get_metadata was listed in my tool surface.',
    }));
    const result = readCapabilityUsage({ 'plugin/model-review': leak });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /available: .*video&#45;analyzer/);
    assert.doesNotMatch(result.warnings[0] ?? '', /attempted:/, 'empty fields stay out of the message');
    assert.doesNotMatch(result.warnings[0] ?? '', /used:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
