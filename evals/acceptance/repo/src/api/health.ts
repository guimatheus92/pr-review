import type { Request, Response } from 'express';
import { audit } from '../audit.js';

export function healthHandler(req: Request, res: Response): Response {
  audit.log(req);
  return res.json({ ok: true });
}
