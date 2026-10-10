import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolConfig } from 'pg';
import { readySchema } from './readiness-fixtures';

const transport = vi.hoisted(() => ({ configurations: [] as PoolConfig[], pools: [] as { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }[] }));
vi.mock('pg', () => ({
  Pool: class {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    connect = vi.fn();
    end = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    constructor(configuration: PoolConfig) { transport.configurations.push(configuration); transport.pools.push(this); }
  }
}));

beforeEach(() => {
  vi.resetModules(); transport.configurations.length = 0; transport.pools.length = 0;
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:unused@invalid.example/practice');
  vi.stubEnv('PRACTICE_DATABASE_POOL_MAX', undefined);
  vi.stubEnv('FEATURE_BILLING', 'false'); vi.stubEnv('FEATURE_EXECUTION', 'false');
  vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'synthetic-session-secret-at-least-thirty-two');
  vi.stubEnv('APP_URL', 'http://127.0.0.1:3000');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('bounded practice/readiness pool composition (fake transport only)', () => {
  it('injects the same single default-max5 pool into the actual service and readiness', async () => {
    const database = await import('../lib/server/database-pool');
    const { getService } = await import('../lib/server/application');
    const { readiness } = await import('../lib/server/operations');
    const service = await getService();
    expect(service.store).toHaveProperty('pool', database.getPracticeDatabasePool());
    const pool = transport.pools[0];
    pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: readySchema() }).mockResolvedValueOnce({ rows: [{ fresh: true, runner_ready: false }] });
    expect((await readiness()).status).toBe('ready');
    expect(transport.configurations).toEqual([{ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5_000, statement_timeout: 2_000, idleTimeoutMillis: 10_000 }]);
    expect(pool.query).toHaveBeenCalledTimes(3);
    await database.closePracticeDatabasePool();
  });

  it('supports an explicit max1 owner injected into a store and readiness without a second pool', async () => {
    const { createPracticeDatabasePool } = await import('../lib/server/database-pool');
    const { PostgresPracticeStore } = await import('../lib/server/postgres-store');
    const { probeReadiness } = await import('../lib/server/operations');
    const owned = createPracticeDatabasePool({ connectionString: process.env.DATABASE_URL!, max: 1 });
    const store = new PostgresPracticeStore(owned.pool);
    expect(store.pool).toBe(owned.pool);
    await probeReadiness(owned.pool, { executionRequired: false });
    await store.close();
    expect(transport.pools[0].end).not.toHaveBeenCalled();
    expect(transport.configurations).toHaveLength(1); expect(transport.configurations[0].max).toBe(1);
    await Promise.all([owned.close(), owned.close()]);
    expect(transport.pools[0].end).toHaveBeenCalledOnce();
  });

  it('retains practice transaction-local timeouts instead of inheriting the operational 2s limit', async () => {
    const { createPracticeDatabasePool } = await import('../lib/server/database-pool');
    const { PostgresPracticeStore } = await import('../lib/server/postgres-store');
    const owned = createPracticeDatabasePool({ connectionString: process.env.DATABASE_URL!, max: 1 });
    const tables = ['ai_practice_sessions', 'ai_practice_snapshots', 'ai_practice_events', 'ai_practice_jobs', 'ai_practice_reports', 'ai_practice_requests', 'ai_practice_usage_ledger', 'ai_practice_deletions', 'ai_practice_turns', 'ai_practice_runs', 'ai_practice_assistant_messages', 'ai_practice_edit_proposals', 'ai_practice_evidence_manifests'];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('to_regclass')) return { rows: [{ table_name: null }] };
      if (sql.includes('as bytes')) return { rows: tables.map(table_name => ({ table_name, bytes: '0', count: '0' })) };
      return { rows: [] };
    });
    const release = vi.fn(); transport.pools[0].connect.mockResolvedValue({ query, release });
    await new PostgresPracticeStore(owned.pool).read();
    expect(query.mock.calls[0][0]).toBe('begin isolation level repeatable read read only');
    expect(query).toHaveBeenCalledWith("select set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $1, true)", ['15000', '5000']);
    expect(query.mock.calls.at(-1)?.[0]).toBe('commit'); expect(release).toHaveBeenCalledOnce();
    await owned.close();
  });

  it('also shares operational admission and worker heartbeats without creating an operations pool', async () => {
    const database = await import('../lib/server/database-pool');
    const operations = await import('../lib/server/operations');
    database.getPracticeDatabasePool();
    const pool = transport.pools[0];
    pool.query.mockResolvedValueOnce({ rows: [{ blocked: false }], rowCount: 1 });
    expect(await operations.executionAdmissionOpen()).toBe(true);
    await operations.blockExecutionAdmission();
    const stop = await operations.startWorkerHeartbeat('synthetic-worker');
    await stop();
    expect(transport.configurations).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('insert into public.practice_worker_heartbeats'), ['synthetic-worker', true, false]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('insert into public.practice_worker_heartbeats'), ['synthetic-worker', false, true]);
    expect(pool.end).not.toHaveBeenCalled(); await database.closePracticeDatabasePool();
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it('honors the strict standalone max1 override and pins the first database/configuration', async () => {
    vi.stubEnv('PRACTICE_DATABASE_POOL_MAX', '1');
    const { getPracticeDatabasePool, closePracticeDatabasePool } = await import('../lib/server/database-pool');
    const first = getPracticeDatabasePool();
    vi.stubEnv('PRACTICE_DATABASE_POOL_MAX', '5'); vi.stubEnv('DATABASE_URL', 'postgresql://different:unused@invalid.example/other');
    expect(getPracticeDatabasePool()).toBe(first);
    expect(transport.configurations).toHaveLength(1); expect(transport.configurations[0].max).toBe(1);
    expect(transport.configurations[0].connectionString).not.toContain('different');
    await closePracticeDatabasePool();
  });

  it.each(['', '0', '6', '-1', '1.5', 'NaN', 'Infinity', '01', ' 1', '1 '])('rejects invalid configured max %j before constructing or connecting', async maximum => {
    vi.stubEnv('PRACTICE_DATABASE_POOL_MAX', maximum);
    const { getPracticeDatabasePool } = await import('../lib/server/database-pool');
    expect(getPracticeDatabasePool).toThrow('Practice storage is unavailable.');
    expect(transport.configurations).toHaveLength(0);
  });

  it.each([0, 6, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('bounds an explicit injected composition at %s', async maximum => {
    const { createPracticeDatabasePool } = await import('../lib/server/database-pool');
    expect(() => createPracticeDatabasePool({ connectionString: process.env.DATABASE_URL!, max: maximum })).toThrow('Practice storage is unavailable.');
    expect(transport.configurations).toHaveLength(0);
  });

  it('does not allocate a pool without a database URL', async () => {
    vi.stubEnv('DATABASE_URL', undefined);
    const database = await import('../lib/server/database-pool');
    expect(database.getPracticeDatabasePool()).toBeNull();
    await database.closePracticeDatabasePool();
    expect(transport.configurations).toHaveLength(0);
    vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:unused@invalid.example/practice');
    expect(database.getPracticeDatabasePool).toThrow('Practice storage is unavailable.');
    expect(transport.configurations).toHaveLength(0);
  });

  it('ends once, waits for the owned close, and cannot reopen during or after shutdown', async () => {
    const database = await import('../lib/server/database-pool');
    database.getPracticeDatabasePool();
    let finish!: () => void;
    transport.pools[0].end.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = database.closePracticeDatabasePool(), second = database.closePracticeDatabasePool();
    expect(first).toBe(second);
    expect(database.getPracticeDatabasePool).toThrow('Practice storage is unavailable.');
    await vi.waitFor(() => expect(transport.pools[0].end).toHaveBeenCalledOnce());
    let closed = false; void first.then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    finish(); await first;
    expect(closed).toBe(true); expect(database.getPracticeDatabasePool).toThrow('Practice storage is unavailable.');
    await database.closePracticeDatabasePool(); expect(transport.configurations).toHaveLength(1);
    expect(transport.pools[0].end).toHaveBeenCalledOnce();
  });

  it('keeps a failed shutdown terminal without repeating end', async () => {
    const database = await import('../lib/server/database-pool');
    database.getPracticeDatabasePool();
    transport.pools[0].end.mockRejectedValue(new Error('synthetic shutdown failure'));
    await expect(database.closePracticeDatabasePool()).rejects.toThrow('synthetic shutdown failure');
    await expect(database.closePracticeDatabasePool()).rejects.toThrow('synthetic shutdown failure');
    expect(transport.pools[0].end).toHaveBeenCalledOnce();
    expect(database.getPracticeDatabasePool).toThrow('Practice storage is unavailable.');
  });

  it('fails readiness/admission closed with sanitized output for invalid bounds or shutdown', async () => {
    vi.stubEnv('PRACTICE_DATABASE_POOL_MAX', '1000-private-config');
    const { readiness, executionAdmissionOpen } = await import('../lib/server/operations');
    const database = await import('../lib/server/database-pool');
    const invalid = await readiness();
    expect(invalid).toMatchObject({ status: 'not_ready', checks: { configuration: 'unconfigured', storage: 'unconfigured' } });
    expect(JSON.stringify(invalid)).not.toMatch(/1000|private-config|postgresql|synthetic/);
    expect(await executionAdmissionOpen()).toBe(false);
    expect(transport.configurations).toHaveLength(0);
    vi.stubEnv('PRACTICE_DATABASE_POOL_MAX', '1'); database.getPracticeDatabasePool();
    await database.closePracticeDatabasePool();
    expect((await readiness()).status).toBe('not_ready'); expect(await executionAdmissionOpen()).toBe(false);
    expect(transport.configurations).toHaveLength(1);
  });

  it('logs only a fixed idle error event instead of the client error contents', async () => {
    const database = await import('../lib/server/database-pool');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    database.getPracticeDatabasePool();
    const [event, listener] = transport.pools[0].on.mock.calls[0];
    expect(event).toBe('error'); listener(new Error('postgresql://synthetic:private@invalid.example learner-source'));
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'practice.pool.failed', category: 'storage' }));
    await database.closePracticeDatabasePool();
  });

  it('preserves the owned string constructor max5 and its separate close behavior', async () => {
    const { PostgresPracticeStore } = await import('../lib/server/postgres-store');
    const store = new PostgresPracticeStore(process.env.DATABASE_URL!);
    expect(transport.configurations).toEqual([{ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5_000 }]);
    await store.close(); expect(transport.pools[0].end).toHaveBeenCalledOnce();
  });
});
