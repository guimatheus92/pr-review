import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireFinalizationLease,
  FinalizationLeaseHeldError,
} from '../src/util/finalization-lease.js';

const DEAD_PID = 2147483646;

test('finalization lease — one live owner excludes a contender and release is ownership-checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-finalization-lease-'));
  try {
    const release = acquireFinalizationLease(dir);
    assert.throws(
      () => acquireFinalizationLease(dir),
      (error: unknown) => error instanceof FinalizationLeaseHeldError && error.preserveRunState,
    );
    release();
    assert.equal(existsSync(join(dir, 'finalization.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('finalization lease — dead owner is reclaimed while corrupt ownership fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-finalization-lease-'));
  const lockPath = join(dir, 'finalization.lock');
  try {
    writeFileSync(lockPath, JSON.stringify({ token: 'stale', pid: DEAD_PID, createdAt: new Date(0).toISOString() }));
    const release = acquireFinalizationLease(dir);
    assert.notEqual(JSON.parse(readFileSync(lockPath, 'utf8')).token, 'stale');
    release();

    writeFileSync(lockPath, '{ corrupt', 'utf8');
    assert.throws(
      () => acquireFinalizationLease(dir),
      (error: unknown) => error instanceof FinalizationLeaseHeldError && error.preserveRunState,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});