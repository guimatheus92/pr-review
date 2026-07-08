import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { consumeStreamLine, newStreamState } from '../src/dispatch/stream-json.js';

test('consumeStreamLine — Task dispatch + result → reviewer ticks in order, pr-review: stripped', () => {
  const state = newStreamState();
  const lines = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Task","input":{"subagent_type":"pr-review:security"}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"task","input":{"agent_type":"pr-review:performance"}}]}}',
    'not json — ignored',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1"}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2"}]}}',
    '{"type":"result","subtype":"success","result":"DONE"}',
  ];
  let now = 1000;
  for (const l of lines) {
    consumeStreamLine(l, state, now);
    now += 1000;
  }
  assert.deepEqual(
    state.ticks.map((t) => t.name),
    ['security', 'performance'],
  );
  assert.equal(state.resultText, 'DONE');
  assert.equal(state.pending.size, 0);
  assert.ok(state.ticks.every((t) => t.elapsedMs >= 0));
});

test('consumeStreamLine — non-Task tool_use is ignored (no phantom reviewers)', () => {
  const state = newStreamState();
  consumeStreamLine(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"r1","name":"Read","input":{}}]}}',
    state,
    0,
  );
  consumeStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"r1"}]}}', state, 5);
  assert.equal(state.ticks.length, 0);
});

test('consumeStreamLine — a result before any Task never crashes; missing subagent_type falls back', () => {
  const state = newStreamState();
  consumeStreamLine(
    '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Task","input":{}}]}}',
    state,
    0,
  );
  consumeStreamLine('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9"}]}}', state, 3);
  assert.deepEqual(
    state.ticks.map((t) => t.name),
    ['reviewer'],
  );
});
