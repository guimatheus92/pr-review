import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { atomicWriteJsonSync, canonicalJson, readAtomicFileSync } from './atomic-json.js';

interface AuthenticatedEnvelope<T> {
  authVersion: 1;
  payload: T;
  mac: string;
}

function controlRoot(recordPath: string): string {
  return dirname(dirname(recordPath));
}

function keyPath(recordPath: string): string {
  return join(controlRoot(recordPath), 'control.key');
}

function readKey(path: string): Buffer {
  const encoded = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(encoded)) throw new Error('control authentication key is corrupt');
  return Buffer.from(encoded, 'hex');
}

function loadOrCreateKey(recordPath: string): Buffer {
  const path = keyPath(recordPath);
  mkdirSync(dirname(path), { recursive: true });
  try {
    return readKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const encoded = randomBytes(32).toString('hex');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, encoded + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return Buffer.from(encoded, 'hex');
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original create error.
      }
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readKey(path);
    throw error;
  }
}

function sign(payload: unknown, key: Buffer): string {
  return createHmac('sha256', key).update(canonicalJson(payload)).digest('hex');
}

export function writeAuthenticatedJsonSync<T>(path: string, payload: T): void {
  const key = loadOrCreateKey(path);
  const envelope: AuthenticatedEnvelope<T> = { authVersion: 1, payload, mac: sign(payload, key) };
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJsonSync(path, envelope);
}

export function readAuthenticatedJsonSync<T>(path: string): T {
  const parsed = JSON.parse(readAtomicFileSync(path)) as Partial<AuthenticatedEnvelope<T>>;
  if (parsed.authVersion !== 1 || parsed.payload === undefined || typeof parsed.mac !== 'string') {
    throw new Error('control record is not an authenticated envelope');
  }
  const expected = sign(parsed.payload, readKey(keyPath(path)));
  const actualBytes = Buffer.from(parsed.mac, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('control record authentication failed');
  }
  return parsed.payload;
}