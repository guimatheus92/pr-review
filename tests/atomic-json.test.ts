import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync, atomicWriteJsonSync, canonicalJson, recoverAtomicFileSync, sha256 } from '../src/util/atomic-json.js';

test('atomicWriteFileSync — first write and replacement leave no temp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    atomicWriteJsonSync(path, { value: 1 });
    atomicWriteJsonSync(path, { value: 2 });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { value: 2 });
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteFileSync — rename failure preserves destination and removes orphan temp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    writeFileSync(path, 'original', 'utf8');
    assert.throws(
      () => atomicWriteFileSync(path, 'replacement', { rename: () => { throw new Error('rename denied'); } }),
      /rename denied/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'original');
    assert.deepEqual(readdirSync(dir), ['state.json']);
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonicalJson and sha256 — key order does not change a fingerprint', () => {
  const left = canonicalJson({ z: 1, omitted: undefined, a: { d: 2, c: [3, 4] } });
  const right = canonicalJson({ a: { c: [3, 4], d: 2 }, z: 1 });
  assert.equal(left, right);
  assert.equal(sha256(left), sha256(right));
  assert.equal(canonicalJson([1, undefined, 3]), '[1,null,3]');
});

test('atomicWriteFileSync — Windows replacement fallback keeps old bytes until new bytes land', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    writeFileSync(path, 'original', 'utf8');
    let calls = 0;
    atomicWriteFileSync(path, 'replacement', {
      rename: (source, destination) => {
        calls++;
        if (calls === 1) {
          const error = new Error('replace rejected') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        renameSync(source, destination);
      },
    });
    assert.equal(calls, 3, 'direct replace, destination backup, then publish');
    assert.equal(readFileSync(path, 'utf8'), 'replacement');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteFileSync — Windows fallback restores the old destination when publish fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    writeFileSync(path, 'original', 'utf8');
    let calls = 0;
    assert.throws(
      () => atomicWriteFileSync(path, 'replacement', {
        rename: (source, destination) => {
          calls++;
          if (calls === 1) {
            const error = new Error('replace rejected') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          }
          if (calls === 3) throw new Error('publish failed');
          renameSync(source, destination);
        },
      }),
      /publish failed/,
    );
    assert.equal(calls, 4, 'the fourth rename restores the backup');
    assert.equal(readFileSync(path, 'utf8'), 'original');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteFileSync — a reader cannot restore the Windows backup during a live replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    const backup = join(dir, '.state.json.bak');
    writeFileSync(path, 'original', 'utf8');
    let calls = 0;
    let readerResult: boolean | undefined;
    atomicWriteFileSync(path, 'replacement', {
      rename: (source, destination) => {
        calls++;
        if (calls === 1) {
          const error = new Error('replace rejected') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        renameSync(source, destination);
        if (calls === 2) {
          assert.ok(existsSync(backup));
          assert.equal(existsSync(path), false);
          readerResult = recoverAtomicFileSync(path);
          assert.ok(existsSync(backup), 'reader leaves the live writer backup untouched');
          assert.equal(existsSync(path), false);
        }
      },
    });
    assert.equal(readerResult, false, 'live transaction tells the reader not to recover');
    assert.equal(readFileSync(path, 'utf8'), 'replacement');
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverAtomicFileSync — restores a destination interrupted after its Windows backup rename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    const backup = join(dir, '.state.json.bak');
    writeFileSync(backup, 'last durable state', 'utf8');
    recoverAtomicFileSync(path);
    assert.equal(readFileSync(path, 'utf8'), 'last durable state');
    assert.equal(existsSync(backup), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverAtomicFileSync — stale takeover never removes a replacement writer marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    const backup = join(dir, '.state.json.bak');
    const transaction = join(dir, '.state.json.txn');
    writeFileSync(backup, 'last durable state', 'utf8');
    writeFileSync(transaction, JSON.stringify({ token: 'stale', pid: 2147483646 }), 'utf8');
    const replacement = JSON.stringify({ token: 'replacement', pid: process.pid });
    const recovered = recoverAtomicFileSync(path, {
      beforeStaleTakeover: () => writeFileSync(transaction, replacement, 'utf8'),
    });
    assert.equal(recovered, false);
    assert.equal(readFileSync(transaction, 'utf8'), replacement);
    assert.equal(readFileSync(backup, 'utf8'), 'last durable state');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recoverAtomicFileSync — stale recovery owns the transaction before touching the backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-review-atomic-'));
  try {
    const path = join(dir, 'state.json');
    const backup = join(dir, '.state.json.bak');
    const transaction = join(dir, '.state.json.txn');
    writeFileSync(backup, 'last durable state', 'utf8');
    writeFileSync(transaction, JSON.stringify({ token: 'stale', pid: 2147483646 }), 'utf8');
    const replacement = JSON.stringify({ token: 'replacement', pid: process.pid });
    const recovered = recoverAtomicFileSync(path, {
      afterStaleTakeover: () => writeFileSync(transaction, replacement, 'utf8'),
    });
    assert.equal(recovered, false);
    assert.equal(readFileSync(transaction, 'utf8'), replacement);
    assert.equal(readFileSync(backup, 'utf8'), 'last durable state');
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});