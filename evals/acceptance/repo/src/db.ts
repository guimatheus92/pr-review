import { Pool } from 'pg';

const pool = new Pool();

/** The sanctioned query entry point: always parameterised. */
export function q<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query(text, params);
}

/** Unparameterised passthrough, kept only for the migration runner. */
export function query<T>(text: string): Promise<{ rows: T[] }> {
  return pool.query(text);
}
