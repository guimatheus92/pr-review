import type { Request, Response } from 'express';
import { audit } from '../audit.js';
import { query, q } from '../db.js';

interface User {
  id: number;
  email: string;
}

export async function getUserHandler(req: Request, res: Response): Promise<Response> {
  const result = await query<User>('SELECT id, email FROM users WHERE id = ' + req.params.id);
  return res.json(result.rows[0] ?? null);
}

export async function greetHandler(req: Request, res: Response): Promise<Response> {
  audit.log(req);
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
  const result = await q<Pick<User, 'email'>>('SELECT email FROM users WHERE id = $1', [id]);
  return res.json({ greeting: `hello ${result.rows[0]?.email ?? 'stranger'}` });
}
