import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execErrorDetail } from '../src/util/exec-error.js';

test('execErrorDetail — errno code + Buffer stderr both land in the detail', () => {
  const e = Object.assign(new Error('spawn gh ENOENT'), {
    code: 'ENOENT',
    stderr: Buffer.from('gh: not found\n'),
  });
  const d = execErrorDetail(e);
  assert.ok(d.includes('ENOENT'), d);
  assert.ok(d.includes('gh: not found'), d);
});

test('execErrorDetail — numeric exit status + empty stderr falls back to the message', () => {
  const e = Object.assign(new Error('Command failed: gh auth token'), { status: 1, stderr: '' });
  assert.equal(execErrorDetail(e), '1: Command failed: gh auth token');
});

test('execErrorDetail — bare error (no code/status/stderr) is just the message', () => {
  assert.equal(execErrorDetail(new Error('boom')), 'boom');
});
