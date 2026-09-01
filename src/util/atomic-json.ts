import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOps {
  rename(source: string, destination: string): void;
}

export interface AtomicRecoveryOps {
  beforeStaleTakeover?(): void;
  afterStaleTakeover?(): void;
}

class AtomicReplacementBusyError extends Error {}

const DEFAULT_OPS: AtomicWriteOps = { rename: renameSync };

function backupPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.bak`);
}

export function atomicFileExistsSync(path: string): boolean {
  return existsSync(path) || existsSync(backupPathFor(path));
}

/** Read the newest durably reachable bytes without renaming writer-owned files. */
export function readAtomicFileSync(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFileSync(backupPathFor(path), 'utf8');
  }
}

function transactionPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.txn`);
}

interface AtomicTransactionOwner {
  token: string;
  pid: number;
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readTransactionOwner(path: string): AtomicTransactionOwner {
  const owner = JSON.parse(readFileSync(path, 'utf8')) as Partial<AtomicTransactionOwner>;
  if (typeof owner.token !== 'string' || !Number.isSafeInteger(owner.pid)) {
    throw new Error(`atomic transaction marker is corrupt: ${path}`);
  }
  return owner as AtomicTransactionOwner;
}

/** Returns false when a live writer owns the Windows replacement window. */
export function recoverAtomicFileSync(path: string, ops: AtomicRecoveryOps = {}): boolean {
  const transactionPath = transactionPathFor(path);
  if (existsSync(transactionPath)) {
    let owner: AtomicTransactionOwner;
    try {
      owner = readTransactionOwner(transactionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return recoverAtomicFileSync(path);
      throw error;
    }
    if (processAlive(owner.pid)) return false;

    ops.beforeStaleTakeover?.();
    const displacedPath = join(dirname(path), `.${basename(path)}.${owner.token}.${randomUUID()}.txn.stale`);
    try {
      renameSync(transactionPath, displacedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return recoverAtomicFileSync(path, ops);
      throw error;
    }
    const displaced = readTransactionOwner(displacedPath);
    if (displaced.token !== owner.token) {
      try {
        linkSync(displacedPath, transactionPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      try { unlinkSync(displacedPath); } catch { /* The current owner remains reachable by its canonical marker. */ }
      return false;
    }

    ops.afterStaleTakeover?.();
    let releaseRecovery: (() => void) | undefined;
    try {
      releaseRecovery = acquireAtomicTransaction(path);
    } catch (error) {
      if (error instanceof AtomicReplacementBusyError) {
        try { unlinkSync(displacedPath); } catch { /* The live writer owns the canonical marker. */ }
        return false;
      }
      try {
        if (!existsSync(transactionPath)) linkSync(displacedPath, transactionPath);
      } catch {
        // Preserve the acquisition error; the displaced marker remains recoverable.
      }
      throw error;
    }
    try {
      const backupPath = backupPathFor(path);
      if (existsSync(backupPath)) {
        if (existsSync(path)) unlinkSync(backupPath);
        else renameSync(backupPath, path);
      }
    } finally {
      releaseRecovery();
      try { unlinkSync(displacedPath); } catch { /* A later cleanup can remove the uniquely named stale marker. */ }
    }
    return true;
  }

  const backupPath = backupPathFor(path);
  if (existsSync(backupPath)) {
    if (existsSync(path)) {
      unlinkSync(backupPath);
    } else {
      renameSync(backupPath, path);
    }
  }
  return true;
}

function acquireAtomicTransaction(path: string): () => void {
  const transactionPath = transactionPathFor(path);
  const owner: AtomicTransactionOwner = { token: randomUUID(), pid: process.pid };
  const candidatePath = join(dirname(path), `.${basename(path)}.${owner.token}.txn.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(candidatePath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    for (;;) {
      try {
        linkSync(candidatePath, transactionPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!recoverAtomicFileSync(path)) {
          throw new AtomicReplacementBusyError(`atomic replacement already in progress for ${path}`);
        }
      }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original error. */ }
    }
    throw error;
  } finally {
    try { if (existsSync(candidatePath)) unlinkSync(candidatePath); } catch { /* Transaction ownership is already decided. */ }
  }

  return () => {
    try {
      if (readTransactionOwner(transactionPath).token === owner.token) unlinkSync(transactionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  };
}

function replaceTempFile(tempPath: string, path: string, ops: AtomicWriteOps): void {
  try {
    ops.rename(tempPath, path);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const replaceRejected = code === 'EPERM' || code === 'EEXIST' || code === 'ENOTEMPTY';
    if (!replaceRejected || !existsSync(path)) throw error;
  }

  // Windows can reject rename(temp, existing) with EPERM. Keep the old bytes
  // durably reachable under a same-directory backup until the new file lands.
  const backupPath = backupPathFor(path);
  const releaseTransaction = acquireAtomicTransaction(path);
  try {
    ops.rename(path, backupPath);
    try {
      ops.rename(tempPath, path);
    } catch (publishError) {
      try {
        if (!existsSync(path) && existsSync(backupPath)) ops.rename(backupPath, path);
      } catch (restoreError) {
        throw new AggregateError(
          [publishError, restoreError],
          `atomic replace failed and the previous file remains at ${backupPath}`,
        );
      }
      throw publishError;
    }
    try {
      unlinkSync(backupPath);
    } catch {
      // The replacement is durable; an orphan backup is safer than failing a committed write.
    }
  } finally {
    releaseTransaction();
  }
}

/** Write bytes durably in the destination directory, then publish them with one rename. */
export function atomicWriteFileSync(
  path: string,
  contents: string,
  ops: AtomicWriteOps = DEFAULT_OPS,
): void {
  if (!recoverAtomicFileSync(path)) {
    throw new AtomicReplacementBusyError(`atomic replacement already in progress for ${path}`);
  }
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, 'wx');
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    replaceTempFile(tempPath, path, ops);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      if (existsSync(tempPath)) unlinkSync(tempPath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function atomicWriteJsonSync(path: string, value: unknown, ops: AtomicWriteOps = DEFAULT_OPS): void {
  atomicWriteFileSync(path, JSON.stringify(value, null, 2) + '\n', ops);
}

export function sha256(contents: string | Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

export function sha256File(path: string): string {
  return sha256(readFileSync(path));
}

/** Stable JSON for fingerprints whose key insertion order must not affect trust decisions. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => !['undefined', 'function', 'symbol'].includes(typeof record[key]))
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}