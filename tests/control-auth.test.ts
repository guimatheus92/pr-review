import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAuthenticatedJsonSync, writeAuthenticatedJsonSync } from '../src/util/control-auth.js';

test('authenticated control record — round-trips and creates a private key outside the run record', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-control-'));
  try {
    const path = join(root, 'control', 'run-id', 'dispatch-plan.json');
    writeAuthenticatedJsonSync(path, { value: 1 });
    assert.deepEqual(readAuthenticatedJsonSync(path), { value: 1 });
    assert.match(readFileSync(join(root, 'control', 'control.key'), 'utf8'), /^[0-9a-f]{64}\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated control record — payload tampering fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-control-'));
  try {
    const path = join(root, 'control', 'run-id', 'delivery-state.json');
    writeAuthenticatedJsonSync(path, { kind: 'recoverable-incomplete' });
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as { payload: { kind: string }; mac: string };
    envelope.payload.kind = 'complete';
    writeFileSync(path, JSON.stringify(envelope), 'utf8');
    assert.throws(() => readAuthenticatedJsonSync(path), /authentication failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated control record — a missing key is never silently replaced during read', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-review-control-'));
  try {
    const path = join(root, 'control', 'run-id', 'delivery-state.json');
    const key = join(root, 'control', 'control.key');
    writeAuthenticatedJsonSync(path, { kind: 'complete' });
    unlinkSync(key);
    assert.throws(() => readAuthenticatedJsonSync(path), /ENOENT/);
    assert.equal(existsSync(key), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
