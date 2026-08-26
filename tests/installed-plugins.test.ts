import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverInstalledPlugins, discoverMcpCapabilities } from '../src/plugins/installed.js';
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

test('readCapabilityUsage — records proven MCP use and degrades missing evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-capability-usage-'));
  try {
    const valid = join(root, 'valid.json');
    writeFileSync(valid, JSON.stringify({
      reviewer: 'ignored-spoof',
      available: ['model-inspector'],
      attempted: ['model-inspector'],
      used: ['model-inspector'],
      notes: 'Read-only validation completed.',
    }));
    const result = readCapabilityUsage({
      'plugin/model-review': valid,
      'plugin/missing-review': join(root, 'missing.json'),
    });
    assert.deepEqual(result.usage, [{
      reviewer: 'plugin/model-review',
      available: ['model-inspector'],
      attempted: ['model-inspector'],
      used: ['model-inspector'],
      notes: 'Read-only validation completed.',
    }]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /produced no MCP usage evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
