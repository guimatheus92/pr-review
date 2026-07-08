import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPostedMarker, writePostedMarker } from '../src/util/posted-marker.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'pr-marker-'));
}

test('readPostedMarker — absent → null (safe to post)', () => {
  const d = tmp();
  try {
    assert.equal(readPostedMarker(d), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — round-trips a well-formed marker', () => {
  const d = tmp();
  try {
    writePostedMarker(d, { posted: 5, attempted: 5 });
    const m = readPostedMarker(d);
    assert.notEqual(m, null);
    assert.notEqual(m, 'corrupt');
    assert.equal((m as { posted: number }).posted, 5);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('readPostedMarker — unparseable or misshapen → "corrupt" (fail-closed signal, not "absent")', () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'posted.marker'), '{ not json', 'utf8');
    assert.equal(readPostedMarker(d), 'corrupt');
    writeFileSync(join(d, 'posted.marker'), '{"postedAt":1}', 'utf8'); // missing posted/attempted
    assert.equal(readPostedMarker(d), 'corrupt');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
