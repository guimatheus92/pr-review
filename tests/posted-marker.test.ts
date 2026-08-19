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

test('readPostedMarker — carries the verified flag; an old marker without one reads as verified', () => {
  const d = tmp();
  try {
    writePostedMarker(d, { posted: 0, attempted: 3, verified: false });
    assert.equal((readPostedMarker(d) as { verified?: boolean }).verified, false);
    // Markers written before 0.6.1 have no flag — absent must not read as
    // unverified, or every pre-existing run dir would lock its own resume out.
    writeFileSync(join(d, 'posted.marker'), '{"postedAt":1,"posted":2,"attempted":2}', 'utf8');
    assert.equal((readPostedMarker(d) as { verified?: boolean }).verified, undefined);
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
