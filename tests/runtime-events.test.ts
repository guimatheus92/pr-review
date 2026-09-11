import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCopilotRuntimeEvents } from '../src/dispatch/runtime-events.js';
import { redactRuntimeSecretsWithMetrics, safeRuntimeDiagnostic } from '../src/util/text.js';

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function taskStart(toolCallId: string, name: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'tool.execution_start',
    data: {
      toolCallId,
      toolName: 'task',
      arguments: {
        name,
        agent_type: 'general-purpose',
        prompt: 'Read the materialized review context.',
        description: 'Review quality',
        mode: 'sync',
      },
    },
    ...extra,
  };
}

function taskComplete(toolCallId: string, content: string, success = true, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'tool.execution_complete',
    data: { toolCallId, success, result: { content } },
    ...extra,
  };
}

test('parseCopilotRuntimeEvents — pairs one top-level named task and captures Auto resolution', () => {
  const transcript = jsonl(
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna' } },
    taskStart('call-quality', 'pr-review-quality--a1b2c3'),
    { type: 'subagent.started', agentId: 'nested-agent', data: { toolCallId: 'call-quality' } },
    taskComplete('call-quality', '[]'),
    { type: 'result', data: { content: 'DONE' } },
  );

  const parsed = parseCopilotRuntimeEvents(transcript);

  assert.equal(parsed.valid, true);
  assert.equal(parsed.resolvedModel, 'gpt-5.6-luna');
  assert.equal(parsed.runtimeError, undefined);
  assert.deepEqual(parsed.taskResults, [{
    taskName: 'pr-review-quality--a1b2c3',
    toolCallId: 'call-quality',
    content: '[]',
  }]);
  assert.deepEqual(parsed.ambiguousTaskNames, []);
});

test('parseCopilotRuntimeEvents — ignores nested task events even when they reuse a top-level identity', () => {
  const transcript = jsonl(
    taskStart('call-top', 'pr-review-quality--a1b2c3'),
    taskStart('call-nested', 'pr-review-quality--a1b2c3', { agentId: 'nested-agent' }),
    taskComplete('call-nested', '[{"severity":"HIGH"}]', true, { agentId: 'nested-agent' }),
    taskComplete('call-top', '[]'),
  );

  const parsed = parseCopilotRuntimeEvents(transcript);

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults.map((result) => result.toolCallId), ['call-top']);
  assert.deepEqual(parsed.ambiguousTaskNames, []);
});

test('parseCopilotRuntimeEvents — duplicate task names are ambiguous and cannot be adopted', () => {
  const transcript = jsonl(
    taskStart('call-first', 'pr-review-quality--a1b2c3'),
    taskStart('call-second', 'pr-review-quality--a1b2c3'),
    taskComplete('call-first', '[]'),
    taskComplete('call-second', '[]'),
  );

  const parsed = parseCopilotRuntimeEvents(transcript);

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
  assert.deepEqual(parsed.ambiguousTaskNames, ['pr-review-quality--a1b2c3']);
});

test('parseCopilotRuntimeEvents — prose task results are not adoptable', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskStart('call-prose', 'pr-review-prose--111'),
    taskComplete('call-prose', 'No findings.'),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
});

test('parseCopilotRuntimeEvents — failed task results are not adoptable', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskStart('call-failed', 'pr-review-failed--222'),
    taskComplete('call-failed', '[]', false),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
});

test('parseCopilotRuntimeEvents — completions without starts are not adoptable', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskComplete('call-orphan', '[]'),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /orphan task completion/);
});

test('parseCopilotRuntimeEvents — malformed JSONL invalidates all fallback results', () => {
  const parsed = parseCopilotRuntimeEvents([
    JSON.stringify(taskStart('call-quality', 'pr-review-quality--a1b2c3')),
    '{not-json',
    JSON.stringify(taskComplete('call-quality', '[]')),
  ].join('\n'));

  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /line 2.*invalid JSON/i);
});

test('parseCopilotRuntimeEvents — conflicting Auto resolutions fail closed', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna' } },
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'claude-sonnet-5' } },
  ));

  assert.equal(parsed.valid, false);
  assert.equal(parsed.resolvedModel, undefined);
  assert.match(parsed.diagnostics.join('\n'), /conflicting.*resolved model/i);
});

test('parseCopilotRuntimeEvents — only the pre-dispatch Auto event is root model provenance', () => {
  const transcript = jsonl(
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-luna' } },
    taskStart('call-quality', 'pr-review-quality--a1b2c3'),
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'gpt-5.6-terra' } },
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'mai-code-1.1-flash' } },
    taskComplete('call-quality', '[]'),
  );

  const parsed = parseCopilotRuntimeEvents(transcript);

  assert.equal(parsed.valid, true);
  assert.equal(parsed.resolvedModel, 'gpt-5.6-luna');
  assert.deepEqual(parsed.taskResults.map((result) => result.toolCallId), ['call-quality']);
});

test('parseCopilotRuntimeEvents — duplicate toolCallId starts cannot select the first reviewer', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskStart('call-shared', 'pr-review-first--111'),
    taskStart('call-shared', 'pr-review-second--222'),
    taskComplete('call-shared', '[]'),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /duplicate task start/i);
});

test('parseCopilotRuntimeEvents — duplicate completions cannot select the first payload', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskStart('call-quality', 'pr-review-quality--a1b2c3'),
    taskComplete('call-quality', '[]'),
    taskComplete('call-quality', '[{"severity":"HIGH","title":"different","body":"different"}]'),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /duplicate task completion/i);
});

test('parseCopilotRuntimeEvents — orphan completion followed by a reused call id is not adoptable', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskComplete('call-reused', '[]'),
    taskStart('call-reused', 'pr-review-quality--a1b2c3'),
    taskComplete('call-reused', '[]'),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /orphan task completion|duplicate task completion/i);
});

test('parseCopilotRuntimeEvents — Auto cannot be recorded as its own concrete resolution', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl(
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'AUTO' } },
  ));

  assert.equal(parsed.valid, false);
  assert.equal(parsed.resolvedModel, undefined);
  assert.match(parsed.diagnostics.join('\n'), /non-concrete.*Auto/i);
});

test('parseCopilotRuntimeEvents — provider-style model ids are accepted and shell metacharacters are refused', () => {
  const safe = parseCopilotRuntimeEvents(jsonl(
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'openai/gpt-5.6-luna' } },
  ));
  assert.equal(safe.valid, true);
  assert.equal(safe.resolvedModel, 'openai/gpt-5.6-luna');

  const unsafe = parseCopilotRuntimeEvents(jsonl(
    { type: 'session.auto_mode_resolved', data: { chosenModel: 'model&echo' } },
  ));
  assert.equal(unsafe.valid, false);
  assert.equal(unsafe.resolvedModel, undefined);
});

test('parseCopilotRuntimeEvents — runtime errors are printable, single-line, and bounded', () => {
  const parsed = parseCopilotRuntimeEvents(jsonl({
    type: 'session.error',
    data: { message: `Execution failed:\n400 advisor\u0000 ${'x'.repeat(4_000)}` },
  }));

  const runtimeError = parsed.runtimeError ?? '';
  assert.match(runtimeError, /^Execution failed:400 advisor/);
  assert.equal(runtimeError.includes('\n'), false);
  assert.equal(runtimeError.includes('\u0000'), false);
  assert.ok(runtimeError.length <= 1_000);
});

test('parseCopilotRuntimeEvents — stream bytes over 64 MiB fail closed before parsing', () => {
  const parsed = parseCopilotRuntimeEvents(' '.repeat(64 * 1024 * 1024 + 1));

  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /exceeds 67108864 bytes/);
});

test('parseCopilotRuntimeEvents — the 20,001st nonblank event invalidates all adoption', () => {
  const lines = [
    JSON.stringify(taskStart('call-quality', 'pr-review-quality--a1b2c3')),
    JSON.stringify(taskComplete('call-quality', '[]')),
    ...Array.from({ length: 19_999 }, () => '{}'),
  ];
  const parsed = parseCopilotRuntimeEvents(lines.join('\n'));

  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.taskResults, []);
  assert.match(parsed.diagnostics.join('\n'), /exceeds 20000 events/);
});

test('parseCopilotRuntimeEvents — 256 task starts are allowed and the 257th fails closed', () => {
  const starts = Array.from({ length: 256 }, (_, index) =>
    taskStart(`call-${index}`, `pr-review-${index}--a1b2c3`));
  const boundary = parseCopilotRuntimeEvents(jsonl(...starts));
  assert.equal(boundary.valid, true);

  const over = parseCopilotRuntimeEvents(jsonl(
    ...starts,
    taskStart('call-256', 'pr-review-256--a1b2c3'),
    taskComplete('call-256', '[]'),
  ));
  assert.equal(over.valid, false);
  assert.deepEqual(over.taskResults, []);
  assert.match(over.diagnostics.join('\n'), /exceeds 256 tasks/);
});

test('parseCopilotRuntimeEvents — task results over 1 MiB are never adoptable', () => {
  const oversized = JSON.stringify([{
    severity: 'LOW',
    title: 'large',
    body: 'x'.repeat(1024 * 1024),
  }]);
  const parsed = parseCopilotRuntimeEvents(jsonl(
    taskStart('call-large', 'pr-review-large--a1b2c3'),
    taskComplete('call-large', oversized),
  ));

  assert.equal(parsed.valid, true);
  assert.deepEqual(parsed.taskResults, []);
});

test('safeRuntimeDiagnostic — masks authorization, URL credentials, and secret assignments', () => {
  const diagnostic = safeRuntimeDiagnostic(
    'request https://user:super-secret@example.test failed\nAuthorization: Bearer abc.def.ghi\napi_key=material-value',
  )!;
  assert.match(diagnostic, /request https:\/\/user:\[REDACTED\]@example\.test failed/);
  assert.match(diagnostic, /Authorization:\[REDACTED\]/);
  assert.match(diagnostic, /api_key=\[REDACTED\]/);
  assert.doesNotMatch(diagnostic, /super-secret|abc\.def\.ghi|material-value/);

  const custom = safeRuntimeDiagnostic('upstream rejected Authorization = Custom opaque-auth-value; retry refused')!;
  assert.match(custom, /Authorization=\[REDACTED\]; retry refused/);
  assert.doesNotMatch(custom, /Custom|opaque-auth-value/);

  const json = safeRuntimeDiagnostic(JSON.stringify({
    client_secret:
      'material-value',
    Authorization:
      'Custom opaque-secret',
    detail: 'actionable cause',
  }))!;
  assert.match(json, /"client_secret":"\[REDACTED\]"/);
  assert.match(json, /"Authorization":"\[REDACTED\]"/);
  assert.match(json, /actionable cause/);
  assert.doesNotMatch(json, /material-value|opaque-secret/);

  const embedded = JSON.stringify({
    type: 'session.error',
    data: { message: JSON.stringify({ clientSecret: 'escaped-secret' }) },
  });
  const embeddedDiagnostic = safeRuntimeDiagnostic(embedded)!;
  assert.match(embeddedDiagnostic, /clientSecret/);
  assert.match(embeddedDiagnostic, /\[REDACTED\]/);
  assert.doesNotMatch(embeddedDiagnostic, /escaped-secret/);

  const splitKey = safeRuntimeDiagnostic('client\0Secret=control-secret')!;
  assert.equal(splitKey, 'clientSecret=[REDACTED]');
  assert.doesNotMatch(splitKey, /control-secret/);

  const escapedControlKey = safeRuntimeDiagnostic(JSON.stringify({
    ['client\0Secret']: 'escaped-control-secret',
  }))!;
  assert.match(escapedControlKey, /\[REDACTED\]/);
  assert.doesNotMatch(escapedControlKey, /escaped-control-secret/);

  const azureSecretName = ['AZURE', 'CLIENT', 'SECRET'].join('_');
  const environmentSecret = safeRuntimeDiagnostic(`${azureSecretName}=opaque-azure-secret`)!;
  assert.equal(environmentSecret, `${azureSecretName}=[REDACTED]`);
  assert.doesNotMatch(environmentSecret, /opaque-azure-secret/);

  const truncatedEmbedded = safeRuntimeDiagnostic('prefix {\\"clientSecret\\":\\"truncated-secret')!;
  assert.match(truncatedEmbedded, /\[REDACTED\]/);
  assert.doesNotMatch(truncatedEmbedded, /truncated-secret/);

  const escapedUnicodeKey = safeRuntimeDiagnostic('prefix {\\"client\\u0053ecret\\":\\"unicode-secret')!;
  assert.match(escapedUnicodeKey, /\[REDACTED\]/);
  assert.doesNotMatch(escapedUnicodeKey, /unicode-secret/);

  const doublyEscapedUnicodeKey = safeRuntimeDiagnostic(
    String.raw`prefix {\"client\\u0053ecret\":\"double-escaped-secret`,
  )!;
  assert.match(doublyEscapedUnicodeKey, /\[REDACTED\]/);
  assert.doesNotMatch(doublyEscapedUnicodeKey, /double-escaped-secret/);

  const awsSecret = safeRuntimeDiagnostic('AWS_SECRET_ACCESS_KEY=aws-secret-value')!;
  assert.equal(awsSecret, 'AWS_SECRET_ACCESS_KEY=[REDACTED]');

  for (const input of [
    'AWS_ACCESS_KEY_ID=example-access-id',
    'SharedAccessSignature=example-shared-signature',
    'Ocp-Apim-Subscription-Key=example-subscription-key',
    'Cookie=session=example-cookie',
  ]) {
    const output = safeRuntimeDiagnostic(input)!;
    assert.match(output, /\[REDACTED\]/);
    assert.doesNotMatch(output, /example-/);
  }

  const sas = safeRuntimeDiagnostic('request https://x.blob.core.windows.net/c?sp=r&sig=sas-secret%2Fabc%3D&sv=1 failed')!;
  assert.match(sas, /sp=r&sig=\[REDACTED\]&sv=1/);
  assert.doesNotMatch(sas, /sas-secret/);

  const longScheme = `${'a'.repeat(64)}://user:long-scheme-secret@example.test/path`;
  const longSchemeDiagnostic = safeRuntimeDiagnostic(longScheme)!;
  assert.match(longSchemeDiagnostic, /user:\[REDACTED\]@example\.test/);
  assert.doesNotMatch(longSchemeDiagnostic, /long-scheme-secret/);

  let nested: string = JSON.stringify({ clientSecret: 'deep-secret' });
  for (let depth = 0; depth < 20; depth++) nested = JSON.stringify({ message: nested });
  const nestedDiagnostic = safeRuntimeDiagnostic(nested)!;
  assert.match(nestedDiagnostic, /\[REDACTED\]/);
  assert.doesNotMatch(nestedDiagnostic, /deep-secret/);

  const oversizedNested = JSON.stringify({
    message: `${JSON.stringify({ ['client\\u0053ecret']: 'oversized-secret' })}${'x'.repeat(1_048_576)}`,
  });
  const oversizedDiagnostic = safeRuntimeDiagnostic(oversizedNested, oversizedNested.length)!;
  assert.match(oversizedDiagnostic, /\[REDACTED\]/);
  assert.doesNotMatch(oversizedDiagnostic, /oversized-secret/);

  const jwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`;
  const keyless = safeRuntimeDiagnostic(`identity provider rejected ${jwt} during refresh`)!;
  assert.equal(keyless, 'identity provider rejected [REDACTED] during refresh');

  for (const label of ['PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
    const pem = `-----BEGIN ${label}-----\nsecret-material\n-----END ${label}-----`;
    assert.equal(safeRuntimeDiagnostic(`load failed: ${pem}`), 'load failed: [REDACTED]');
    const truncated = `-----BEGIN ${label}-----\ntruncated-secret-material`;
    assert.equal(safeRuntimeDiagnostic(`load failed: ${truncated}`), 'load failed: [REDACTED]');
  }
});

test('redactRuntimeSecrets — non-URL text performs one protocol search', () => {
  const input = 'a'.repeat(100_000);
  const result = redactRuntimeSecretsWithMetrics(input);
  assert.equal(result.value, input);
  assert.equal(result.metrics.urlProtocolSearches, 1);
  assert.equal(result.metrics.urlSchemeCharacters, 0);
  assert.equal(result.metrics.urlAuthorityCharacters, 0);
});

test('redactRuntimeSecrets — repeated unterminated private-key headers use one forward search pair', () => {
  const header = `-----BEGIN ${'PRIVATE KEY'}-----\n`;
  const input = header.repeat(25_600);
  const result = redactRuntimeSecretsWithMetrics(input);
  assert.equal(result.value, '[REDACTED]');
  assert.equal(result.metrics.pemHeaderSearches, 1);
  assert.equal(result.metrics.pemFooterSearches, 1);
});