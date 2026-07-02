import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { normalizeModel, resolveRuntime, runtimeSpawnArgs, taskCall } from '../src/dispatch/runtime.js';

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
    '--model', 'm1', '--allow-all-tools', '--no-ask-user', '--add-dir', '/dir', '-s',
  ]);
  assert.deepEqual(runtimeSpawnArgs('claude', 'opus', '/dir'), [
    '-p', '--model', 'opus', '--dangerously-skip-permissions', '--add-dir', '/dir',
  ]);
});

test('taskCall — tool vocabulary per runtime', () => {
  assert.equal(taskCall('copilot', 'pr-review:security', 'go'), 'task(agent_type="pr-review:security", prompt="go")');
  assert.equal(taskCall('claude', 'pr-review:security', 'go'), 'Task(subagent_type="pr-review:security", prompt="go")');
});
