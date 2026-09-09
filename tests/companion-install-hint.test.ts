import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { formatWarning, installCommandFor, KNOWN_COMPANIONS } from '../src/plugins/companions.js';

/**
 * The hint told every runtime to type Claude Code slash commands "Inside a
 * `copilot` session". The Copilot CLI has no `/plugin` — the advice cannot be
 * followed, so the plugins stay uninstalled and the review quietly runs with
 * seven fewer reviewers than it planned for.
 *
 * These assert what the far side ACCEPTS, not what this side happens to emit:
 * the copilot strings are the two commands that were run end to end on win32
 * (`copilot plugin marketplace add anthropics/claude-code`, then
 * `copilot plugin install <id>@claude-code-plugins`), after which
 * `copilot plugin list` reports both and `doctor` reports 6 + 1 dispatches.
 */

test('formatWarning — copilot gets shell commands, never slash commands', () => {
  const warn = formatWarning(KNOWN_COMPANIONS, 'copilot');
  assert.ok(warn.includes('copilot plugin marketplace add anthropics/claude-code'));
  assert.ok(warn.includes('copilot plugin install pr-review-toolkit@claude-code-plugins'));
  assert.ok(warn.includes('copilot plugin install code-review@claude-code-plugins'));
  assert.ok(!/^\s*\/plugin/m.test(warn), 'a slash command is not runnable in the Copilot CLI');
  assert.ok(!warn.includes('slash commands'), 'the heading must not promise slash commands either');
});

test('formatWarning — claude keeps the slash commands, which are correct there', () => {
  const warn = formatWarning(KNOWN_COMPANIONS, 'claude');
  assert.ok(warn.includes('/plugin marketplace add anthropics/claude-code'));
  assert.ok(warn.includes('/plugin install pr-review-toolkit@claude-code-plugins'));
  assert.ok(!warn.includes('copilot plugin'), 'a shell command is not what a claude session takes');
  assert.ok(warn.includes('Inside a `claude` session'));
});

test('formatWarning — the marketplace line is printed once, not once per plugin', () => {
  for (const runtime of ['copilot', 'claude'] as const) {
    const warn = formatWarning(KNOWN_COMPANIONS, runtime);
    const marketplaceLines = warn.split('\n').filter((line) => line.includes('marketplace add'));
    assert.equal(marketplaceLines.length, 1, `${runtime} repeated the marketplace line`);
  }
});

test('formatWarning — nothing missing, nothing printed', () => {
  assert.equal(formatWarning([], 'copilot'), '');
  assert.equal(formatWarning([], 'claude'), '');
});

test('formatWarning — every runtime keeps the opt-out, and both companions are named', () => {
  for (const runtime of ['copilot', 'claude'] as const) {
    const warn = formatWarning(KNOWN_COMPANIONS, runtime);
    assert.ok(warn.includes('--no-companions'), `${runtime} lost the opt-out`);
    assert.ok(warn.includes('pr-review-toolkit') && warn.includes('code-review'));
  }
});

test('KNOWN_COMPANIONS — every companion carries an install path for BOTH runtimes', () => {
  // A companion added later must not inherit one runtime's syntax by omission:
  // that is exactly how the copilot hint went wrong and stayed wrong.
  for (const companion of KNOWN_COMPANIONS) {
    assert.ok(companion.installSlash.startsWith('/plugin install '), companion.id);
    assert.ok(companion.marketplaceSlash.startsWith('/plugin marketplace add '), companion.id);
    assert.ok(companion.installCommand.startsWith('copilot plugin install '), companion.id);
    assert.ok(companion.marketplaceCommand.startsWith('copilot plugin marketplace add '), companion.id);
    // The id the CLI installs must be the id detection matches on, or the hint
    // "installs" something `recognized` will never contain.
    assert.ok(companion.installCommand.includes(`install ${companion.id}@`), companion.id);
    assert.ok(companion.installSlash.includes(`install ${companion.id}@`), companion.id);
  }
});

test('KNOWN_COMPANIONS — the marketplace named is the one the Copilot CLI accepts', () => {
  // anthropics/claude-plugins-official carries the same two plugins, and Claude
  // Code installs from it — but the Copilot CLI validates marketplace.json
  // against its own schema and rejects ~90 of that catalog's 292 entries
  // ("plugins.N.source: Invalid input"). anthropics/claude-code passes.
  for (const companion of KNOWN_COMPANIONS) {
    assert.ok(companion.marketplaceCommand.endsWith('anthropics/claude-code'), companion.id);
    assert.ok(companion.installCommand.endsWith('@claude-code-plugins'), companion.id);
  }
});

/**
 * `formatWarning` was never the only surface handing a user an install command.
 * `doctor` renders one per missing companion, and the first fix left it on
 * `installSlash` for both runtimes -- in the very command someone with missing
 * companions runs to find out. Both now route through `installCommandFor`, so
 * the mapping exists once.
 */
test('installCommandFor — selects the command the runtime can actually run', () => {
  for (const companion of KNOWN_COMPANIONS) {
    assert.equal(installCommandFor(companion, 'copilot'), companion.installCommand);
    assert.equal(installCommandFor(companion, 'claude'), companion.installSlash);
    assert.ok(installCommandFor(companion, 'copilot').startsWith('copilot plugin install '), companion.id);
    assert.ok(installCommandFor(companion, 'claude').startsWith('/plugin install '), companion.id);
  }
});

test('installCommandFor — the two runtimes never receive the same string', () => {
  // The defect was one string served to both. Distinctness is the property that
  // makes "we fixed it for every consumer" checkable rather than asserted.
  for (const companion of KNOWN_COMPANIONS) {
    assert.notEqual(installCommandFor(companion, 'copilot'), installCommandFor(companion, 'claude'), companion.id);
  }
});

test('formatWarning — routes through installCommandFor, so no consumer drifts', () => {
  for (const runtime of ['copilot', 'claude'] as const) {
    const warn = formatWarning(KNOWN_COMPANIONS, runtime);
    for (const companion of KNOWN_COMPANIONS) {
      assert.ok(warn.includes(installCommandFor(companion, runtime)), `${runtime}/${companion.id}`);
    }
  }
});
