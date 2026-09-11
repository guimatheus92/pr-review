import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_MODEL, MCP_PROCESS_DENIAL, normalizeModel, resolveRuntime, runtimeDisablesAmbientPlugins, runtimeSpawnEnvironment, runtimeTaskName, RUNTIMES, runtimeSpawnArgs, sanitizeTaskDescription, taskCall } from '../src/dispatch/runtime.js';

test('normalizeModel — the shipped default becomes each runtime\'s own stable alias', () => {
  // The previous version of this test asserted the default reached copilot
  // verbatim, which is what shipped and what broke: Copilot CLI 1.0.83 answers
  // `Model "claude-opus-4.8" ... is not available` and exits 1 before
  // dispatching anything, so every reviewer reads as failed to deliver.
  assert.equal(normalizeModel('claude', DEFAULT_MODEL), 'opus');
  assert.equal(normalizeModel('copilot', DEFAULT_MODEL), 'auto');
});

test('normalizeModel — an explicit model is passed through untouched, on both runtimes', () => {
  // Only the default is translated. Mapping a user's explicit choice would
  // silently review with a model they did not ask for.
  for (const runtime of RUNTIMES) {
    assert.equal(normalizeModel(runtime, 'sonnet'), 'sonnet');
    assert.equal(normalizeModel(runtime, 'claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(normalizeModel(runtime, 'gpt-5.6'), 'gpt-5.6');
  }
});

test('normalizeModel — the default is never a literal model id at the spawn boundary', () => {
  // The regression guard: a concrete id is the thing a vendor retires. If this
  // ever fails, the default is being handed to a CLI verbatim again.
  for (const runtime of RUNTIMES) {
    assert.notEqual(normalizeModel(runtime, DEFAULT_MODEL), DEFAULT_MODEL);
  }
});

test('resolveRuntime — explicit runtime wins over a binary override', () => {
  assert.equal(resolveRuntime('claude', '/custom/path/copilot'), 'claude');
  assert.equal(resolveRuntime('copilot'), 'copilot');
});

test('resolveRuntime — a --copilot binary override implies the copilot runtime', () => {
  assert.equal(resolveRuntime('auto', '/custom/copilot.cmd'), 'copilot');
  assert.equal(resolveRuntime(undefined, 'copilot'), 'copilot');
});

/** A probe that "finds" only the named binaries — `where`/`which` exit non-zero otherwise. */
function pathWith(...found: string[]) {
  const probed: string[] = [];
  const exec = (_file: string, args: string[]) => {
    const name = args[0]!;
    probed.push(name);
    if (!found.includes(name)) throw new Error(`not found: ${name}`);
  };
  return { exec, probed };
}

test('resolveRuntime — probe order is copilot first, then claude', () => {
  const both = pathWith('copilot', 'claude');
  assert.equal(resolveRuntime('auto', undefined, both.exec), 'copilot');
  assert.deepEqual(both.probed, ['copilot'], 'claude must not even be probed once copilot answers');

  const claudeOnly = pathWith('claude');
  assert.equal(resolveRuntime('auto', undefined, claudeOnly.exec), 'claude');
  assert.deepEqual(claudeOnly.probed, ['copilot', 'claude']);
});

test('resolveRuntime — neither on PATH throws, naming both and the escape hatches', () => {
  const neither = pathWith();
  assert.throws(
    () => resolveRuntime('auto', undefined, neither.exec),
    /neither `copilot` nor `claude` is on PATH.*--runtime\/--copilot/s,
  );
});

test('resolveRuntime — an explicit runtime never probes PATH at all', () => {
  const none = pathWith();
  assert.equal(resolveRuntime('claude', undefined, none.exec), 'claude');
  assert.deepEqual(none.probed, [], 'an explicit choice must not depend on what happens to be installed');
});

test('runtimeSpawnArgs — per-runtime argv shape', () => {
  assert.deepEqual(runtimeSpawnArgs('copilot', 'm1', '/dir'), [
    '--model', 'm1', '--allow-all-tools', '--deny-tool=shell', '--disable-builtin-mcps',
    '--excluded-tools=powershell,bash,shell', '--no-custom-instructions', '--no-ask-user',
    '--output-format', 'json', '--stream', 'off', '--add-dir', '/dir', '-s',
  ]);
  assert.deepEqual(runtimeSpawnArgs('claude', 'opus', '/dir'), [
    '-p', '--model', 'opus', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
    '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch,mcp__*',
    '--strict-mcp-config',
    '--setting-sources', 'user', '--add-dir', '/dir',
  ]);
  // Claude WITH a repoRoot and a non-empty server list — the arguments that tempt an
  // edit. `--strict-mcp-config` is categorical, so the per-server list must NOT be
  // expanded here: the claude CLI has no `--disable-mcp-server`, and "completing" the
  // branch would kill every review at spawn. This also pins that no `--mcp-config` is
  // emitted, which is the premise of "the run-dir .mcp.json is provenance only".
  assert.deepEqual(runtimeSpawnArgs('claude', 'opus', '/run', '/repo', ['ado', 'bicep']), [
    '-p', '--model', 'opus', '--permission-mode', 'dontAsk',
    '--tools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
    '--allowedTools', 'Read,Write,Edit,Glob,Grep,Task,Agent',
    '--disallowedTools', 'Bash,PowerShell,WebFetch,WebSearch,mcp__*',
    '--strict-mcp-config',
    '--setting-sources', 'user', '--add-dir', '/run', '--add-dir', '/repo',
  ]);
  assert.deepEqual(runtimeSpawnArgs('copilot', 'm1', '/run', '/repo', ['ado', 'bicep']), [
    '--model', 'm1', '--allow-all-tools', '--deny-tool=shell', '--disable-builtin-mcps',
    '--excluded-tools=powershell,bash,shell', '--no-custom-instructions', '--no-ask-user',
    '--output-format', 'json', '--stream', 'off', '--add-dir', '/run', '--add-dir', '/repo',
    '--disable-mcp-server', 'ado', '--disable-mcp-server', 'bicep', '-s',
  ]);
});

test('runtimeSpawnArgs — EVERY runtime carries its process-level MCP denial', () => {
  // Why this matters lives on MCP_PROCESS_DENIAL; not repeated here so the two cannot
  // drift. What is unique to this test: it walks RUNTIMES instead of naming the two
  // runtimes by hand, because the argv-shape test above already pins those byte-for-byte
  // — the coverage this adds is a runtime added later.
  assert.ok(RUNTIMES.length > 0, 'RUNTIMES is empty — the loop below would assert nothing');
  for (const runtime of RUNTIMES) {
    const argv = runtimeSpawnArgs(runtime, 'm', '/dir');
    assert.ok(argv.includes(MCP_PROCESS_DENIAL[runtime]), `${runtime} lost ${MCP_PROCESS_DENIAL[runtime]}`);
  }
});

test('runtimeSpawnEnvironment — Copilot alone disables ambient plugin discovery', () => {
  const inherited = { PATH: 'test-path', COPILOT_PLUGIN_DIR_ONLY: 'ambient-value' };
  assert.deepEqual(runtimeSpawnEnvironment('copilot', inherited), {
    PATH: 'test-path',
    COPILOT_PLUGIN_DIR_ONLY: 'true',
  });
  assert.deepEqual(runtimeSpawnEnvironment('claude', inherited), inherited);
  assert.equal(runtimeDisablesAmbientPlugins('copilot'), true);
  assert.equal(runtimeDisablesAmbientPlugins('claude'), false);
});

test('taskCall — tool vocabulary per runtime', () => {
  assert.equal(
    taskCall('copilot', 'pr-review:security', 'go', 'Review security', 'pr-review-security--abc123'),
    'task(agent_type="pr-review:security", prompt="go", description="Review security", name="pr-review-security--abc123", mode="sync")',
  );
  assert.equal(
    taskCall('claude', 'pr-review:security', 'go', 'Review security'),
    'Task(subagent_type="pr-review:security", prompt="go", description="Review security")',
  );
});

test('taskCall — JSON-escapes every string argument exactly once', () => {
  const call = taskCall(
    'copilot',
    'agent"type',
    'Read C:\\work\\file.md\nThen say "done"\t`literal`',
    'Réview\nsecurity "pass"',
    'pr-review-agent--abc123',
  );
  assert.equal(
    call,
    'task(agent_type="agent\\"type", prompt="Read C:\\\\work\\\\file.md\\nThen say \\"done\\"\\t`literal`", description="Review security pass", name="pr-review-agent--abc123", mode="sync")',
  );
});

test('runtimeTaskName — reviewer identities become deterministic collision-resistant task names', () => {
  assert.equal(runtimeTaskName('pack/security'), runtimeTaskName('pack/security'));
  assert.notEqual(runtimeTaskName('pack/security'), runtimeTaskName('pack_security'));
  assert.match(runtimeTaskName('pack/security'), /^pr-review-[A-Za-z0-9._-]+--[a-f0-9]{12}$/);
  assert.ok(runtimeTaskName('x'.repeat(500)).length <= 80);
});

test('sanitizeTaskDescription — trusted deterministic bounded label', () => {
  assert.equal(sanitizeTaskDescription('  Réview\nawesome-copilot/security!!!  '), 'Review awesome-copilot/security');
  assert.equal(sanitizeTaskDescription('\u0000☃'), 'Run review task');
  assert.equal(sanitizeTaskDescription('x'.repeat(100)).length, 80);
});
