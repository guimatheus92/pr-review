import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

interface LeaseOwner {
  token: string;
  pid: number;
  createdAt: string;
}

export class FinalizationLeaseHeldError extends Error {
  readonly preserveRunState = true;

  constructor(message: string) {
    super(message);
    this.name = 'FinalizationLeaseHeldError';
  }
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

function readOwner(path: string): LeaseOwner {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LeaseOwner>;
    if (typeof parsed.token === 'string' && Number.isSafeInteger(parsed.pid) && typeof parsed.createdAt === 'string') {
      return parsed as LeaseOwner;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
  }
  throw new FinalizationLeaseHeldError(
    `finalization lease is unreadable at ${path}; refusing concurrent posting`,
  );
}

function writeCandidate(path: string, owner: LeaseOwner): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Preserve the original error. */ }
    }
    try { if (existsSync(path)) unlinkSync(path); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

/** Acquire one finalizer for a run. The returned release is ownership-checked. */
export function acquireFinalizationLease(controlDir: string): () => void {
  mkdirSync(controlDir, { recursive: true });
  const leasePath = join(controlDir, 'finalization.lock');
  const owner: LeaseOwner = { token: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() };
  const candidatePath = join(controlDir, `.finalization.${process.pid}.${owner.token}.tmp`);
  writeCandidate(candidatePath, owner);

  try {
    for (;;) {
      try {
        linkSync(candidatePath, leasePath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const current = readOwner(leasePath);
      if (processAlive(current.pid)) {
        throw new FinalizationLeaseHeldError(
          `run finalization is already in progress under pid ${current.pid}; refusing concurrent posting`,
        );
      }

      const stalePath = join(dirname(leasePath), `.finalization.${current.token}.${owner.token}.stale`);
      try {
        renameSync(leasePath, stalePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const displaced = readOwner(stalePath);
      if (displaced.token !== current.token) {
        try {
          linkSync(stalePath, leasePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        try { unlinkSync(stalePath); } catch { /* The restored owner still has the canonical lease path. */ }
        throw new FinalizationLeaseHeldError(
          `run finalization changed owners during stale recovery; refusing concurrent posting`,
        );
      }
      try { unlinkSync(stalePath); } catch { /* The unique stale name cannot block acquisition. */ }
    }
  } finally {
    try { if (existsSync(candidatePath)) unlinkSync(candidatePath); } catch { /* Lease ownership is already decided. */ }
  }

  return () => {
    try {
      if (readOwner(leasePath).token === owner.token) unlinkSync(leasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        process.stderr.write(`[review] could not release finalization lease: ${(error as Error).message}\n`);
      }
    }
  };
}