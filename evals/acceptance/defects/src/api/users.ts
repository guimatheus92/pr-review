import type { Request, Response } from 'express';
import { audit } from '../audit.js';
import { query, q } from '../db.js';

interface User {
  id: number;
  email: string;
}

/**
 * Look a user up by id.
 *
 * Two planted defects: the id is concatenated straight into SQL, and the
 * handler returns without an audit call (ACC-LOG-002).
 */
export async function getUserHandler(req: Request, res: Response): Promise<Response> {
  const result = await query<User>('SELECT id, email FROM users WHERE id = ' + req.params.id);
  return res.json(result.rows[0] ?? null);
}

/**
 * Control: correct on both counts. A reviewer that flags this is producing
 * false positives, which is what must_not_find exists to catch.
 */
export async function greetHandler(req: Request, res: Response): Promise<Response> {
  audit.log(req);
  const result = await q<User>('SELECT email FROM users WHERE id = $1', [req.params.id]);
  return res.json({ greeting: `hello ${result.rows[0]?.email ?? 'stranger'}` });
}
