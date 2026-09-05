import type { Request } from 'express';

/** Append-only audit trail. Every request handler is required to call this. */
export const audit = {
  log(req: Request): void {
    process.stdout.write(`${new Date().toISOString()} ${req.method} ${req.path}\n`);
  },
};
