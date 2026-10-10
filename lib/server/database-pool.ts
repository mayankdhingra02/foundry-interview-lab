import 'server-only';
import { Pool } from 'pg';
import { HttpError } from './http';

export type PracticeDatabasePool = { readonly pool: Pool; close(): Promise<void> };
export type PracticeDatabasePoolOptions = { connectionString: string; max?: number };

const unavailable = () => new HttpError(503, 'storage_unavailable', 'Practice storage is unavailable.');
function boundedMaximum(max: number): number {
  if (!Number.isSafeInteger(max) || max < 1 || max > 5) throw unavailable();
  return max;
}

/** Explicit owner for a bounded pool. Consumers borrow pool; only its owner closes it. */
export function createPracticeDatabasePool(options: PracticeDatabasePoolOptions): PracticeDatabasePool {
  const max = boundedMaximum(options.max ?? 5);
  if (!options.connectionString.trim()) throw unavailable();
  const pool = new Pool({ connectionString: options.connectionString, max, connectionTimeoutMillis: 5_000, statement_timeout: 2_000, idleTimeoutMillis: 10_000 });
  // Idle client errors must not crash the process or disclose connection details.
  pool.on('error', () => { console.error(JSON.stringify({ event: 'practice.pool.failed', category: 'storage' })); });
  let closing: Promise<void> | undefined;
  return { pool, close: () => closing ??= Promise.resolve().then(() => pool.end()) };
}

let shared: PracticeDatabasePool | undefined;
let closing: Promise<void> | undefined;

/** Lazy standalone composition. Pin its configuration until process shutdown. */
export function getPracticeDatabasePool(): Pool | null {
  if (closing) throw unavailable();
  if (shared) return shared.pool;
  if (!process.env.DATABASE_URL) return null;
  const configured = process.env.PRACTICE_DATABASE_POOL_MAX;
  if (configured !== undefined && !/^[1-5]$/.test(configured)) throw unavailable();
  shared = createPracticeDatabasePool({ connectionString: process.env.DATABASE_URL, max: configured === undefined ? 5 : Number(configured) });
  return shared.pool;
}

/** Terminal, idempotent shutdown; callers must first drain their jobs/requests. */
export function closePracticeDatabasePool(): Promise<void> {
  return closing ??= Promise.resolve().then(() => shared?.close());
}
