import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MCP_PROCESS_DENIAL, normalizeModel, resolveRuntime, RUNTIMES, runtimeSpawnArgs, sanitizeTaskDescription, taskCall } from '../src/dispatch/runtime.js';

test('normalizeModel — only the copilot-style default maps to opus under claude', () => {
  assert.equal(normalizeModel('claude', 'claude-opus-4.8'), 'opus');
  assert.equal(normalizeModel('claude', 'sonnet'), 'sonnet');
  assert.equal(normalizeModel('claude', 'claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModel('copilot', 'claude-opus-4.8'), 'claude-opus-4.8');
});

test('resolveRuntime — explicit runtime wins over a binary override', () => {
  assert.equal(resolveRuntime('claude', '/custom/path/copilot'), 'claude');
  assert.equal(resolveRuntime('copilot'), 'copilot');
});

test('resolveRuntime — a --copilot binary override implies the copilot runtime', () => {
  assert.equal(resolveRuntime('auto', '/custom/copilot.cmd'), 'copilot');
  assert.equal(resolveRuntime(undefined, 'copilot'), 'copilot');
});

test('runtimeSpawnArgs — per-runtime argv shape', () => {
  assert.deepEqual(runtimeSpawnArgs('copilot', 'm1', '/dir'), [
    '--model', 'm1', '--allow-all-tools', '--deny-tool=shell', '--disable-builtin-mcps',
    '--no-custom-instructions', '--no-ask-user', '--add-dir', '/dir', '-s',
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
    '--no-custom-instructions', '--no-ask-user', '--add-dir', '/run', '--add-dir', '/repo',
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

test('taskCall — tool vocabulary per runtime', () => {
  assert.equal(
    taskCall('copilot', 'pr-review:security', 'go', 'Review security'),
    'task(agent_type="pr-review:security", prompt="go", description="Review security")',
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
  );
  assert.equal(
    call,
    'task(agent_type="agent\\"type", prompt="Read C:\\\\work\\\\file.md\\nThen say \\"done\\"\\t`literal`", description="Review security pass")',
  );
});

test('sanitizeTaskDescription — trusted deterministic bounded label', () => {
  assert.equal(sanitizeTaskDescription('  Réview\nawesome-copilot/security!!!  '), 'Review awesome-copilot/security');
  assert.equal(sanitizeTaskDescription('\u0000☃'), 'Run review task');
  assert.equal(sanitizeTaskDescription('x'.repeat(100)).length, 80);
});
