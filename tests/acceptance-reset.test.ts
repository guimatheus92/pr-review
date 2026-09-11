import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCliToken } from '../scripts/acceptance-reset.mjs';

test('resolveCliToken executes Windows .cmd shims without shell mode', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-cli-shim-'));
  try {
    const shim = join(dir, 'fake-token-cli.cmd');
    writeFileSync(shim, '@echo off\r\necho shim-token\r\n', 'utf8');

    assert.equal(resolveCliToken(shim, ['ignored']), 'shim-token');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCliToken refuses Windows cmd metacharacters before executing the shim', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-cli-injection-'));
  try {
    const shim = join(dir, 'fake-token-cli.cmd');
    const marker = join(dir, 'injected.txt');
    writeFileSync(shim, '@echo off\r\necho shim-token\r\n', 'utf8');

    assert.equal(resolveCliToken(shim, [`ignored&echo injected>${marker}`]), null);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});