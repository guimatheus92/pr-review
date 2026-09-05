import { Pool } from 'pg';

const pool = new Pool();

/** The only sanctioned query entry point: always parameterised. */
export function q<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query(text, params);
}

/** Raw escape hatch. Banned by ACC-SQL-001 outside migrations. */
export function query<T>(text: string): Promise<{ rows: T[] }> {
  return pool.query(text);
}
