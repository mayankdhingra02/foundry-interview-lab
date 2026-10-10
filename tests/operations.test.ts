import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { operationalCounters, orphanCandidates, probeReadiness, recordWorkerHeartbeat, setExecutionAdmission } from '../lib/server/operations';
import type { ContainerMetadata } from '../lib/server/operations';

const queryPort = (responses: unknown[][]) => {
  const query = vi.fn();
  for (const rows of responses) query.mockResolvedValueOnce({ rows, rowCount: 1 });
  return { query } as unknown as Pick<Pool, 'query'>;
};

describe('content-free operational readiness', () => {
  it('is not ready without durable storage', async () => {
    const result = await probeReadiness(null, { now: () => new Date('2026-10-09T12:00:00Z') });
    expect(result.status).toBe('not_ready');
    expect(result.checks.storage).toBe('unconfigured');
    expect(result.checkedAt).toBe('2026-10-09T12:00:00.000Z');
  });
  it('never emits connection errors, URLs, credentials, or learner content', async () => {
    const query = vi.fn().mockRejectedValue(new Error('postgres://secret:credential@private-host learner-source-code'));
    const result = await probeReadiness({ query } as unknown as Pool);
    expect(result.status).toBe('not_ready');
    expect(JSON.stringify(result)).not.toMatch(/secret|credential|private-host|learner-source-code/);
  });
  it('stops before querying absent operational schema', async () => {
    const db = queryPort([[], [{ ready: false }]]);
    expect((await probeReadiness(db)).checks.schema).toBe('missing');
    expect(db.query).toHaveBeenCalledTimes(2);
  });
  it('requires a fresh worker and available required execution runtime', async () => {
    const db = queryPort([[], [{ ready: true }], [{ fresh: false, runner_ready: false }], [{ blocked: false }]]);
    const result = await probeReadiness(db);
    expect(result.status).toBe('not_ready');
    expect(result.checks.worker).toBe('stale');
    expect(result.checks.execution).toBe('unavailable');
  });
  it('is ready when durable schema, worker freshness, runtime and shared admission agree', async () => {
    const db = queryPort([[], [{ ready: true }], [{ fresh: true, runner_ready: true }], [{ blocked: false }]]);
    expect((await probeReadiness(db)).status).toBe('ready');
  });
  it('does not admit a deployment with missing identity/origin configuration', async () => {
    const db = queryPort([[], [{ ready: true }], [{ fresh: true, runner_ready: true }], [{ blocked: false }]]);
    const result = await probeReadiness(db, { configurationReady: false });
    expect(result.status).toBe('not_ready');
    expect(result.checks.configuration).toBe('unconfigured');
  });
  it('does not require Docker when execution is deliberately disabled', async () => {
    const db = queryPort([[], [{ ready: true }], [{ fresh: true, runner_ready: false }]]);
    const result = await probeReadiness(db, { executionRequired: false });
    expect(result.status).toBe('ready');
    expect(result.checks.execution).toBe('disabled');
  });
  it('keeps shared cleanup holds closed even with a healthy worker', async () => {
    const db = queryPort([[], [{ ready: true }], [{ fresh: true, runner_ready: true }], [{ blocked: true }]]);
    const result = await probeReadiness(db);
    expect(result.status).toBe('not_ready');
    expect(result.checks.execution).toBe('blocked');
  });
  it('writes only bounded worker metadata with parameterized SQL', async () => {
    const db = queryPort([[]]);
    await recordWorkerHeartbeat(db, 'worker-one', true, false);
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual(['worker-one', true, false]);
    await expect(recordWorkerHeartbeat(db, 'worker with code\nsecret', true)).rejects.toThrow('Invalid worker');
  });
  it('requires consistent shared admission state and confirms a row was updated', async () => {
    const db = queryPort([[]]);
    await expect(setExecutionAdmission(db, true, null)).rejects.toThrow('disagree');
    await setExecutionAdmission(db, true, 'cleanup_unconfirmed');
    expect(vi.mocked(db.query).mock.calls[0][1]).toEqual([true, 'cleanup_unconfirmed', 'execution_admission']);
    const absent = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) } as unknown as Pool;
    await expect(setExecutionAdmission(absent, false, null)).rejects.toThrow('missing');
  });
  it('restricts operator diagnostics to aggregate counts and queue age', async () => {
    const db = queryPort([[{ queued: 3, running: 1, expired: 0, oldest_queue_seconds: 12, pending_deletions: 0 }]]);
    expect(await operationalCounters(db)).toEqual({ queued: 3, running: 1, expired: 0, oldest_queue_seconds: 12, pending_deletions: 0 });
    expect(vi.mocked(db.query).mock.calls[0][0]).not.toMatch(/runtime_payload|files|transcript|safe_error/);
  });
});

describe('orphan reconciliation eligibility', () => {
  const now = new Date('2026-10-09T12:00:00Z');
  const container: ContainerMetadata = { id: 'a'.repeat(64), name: '/foundry-run-01234567-89ab', createdAt: '2026-10-09T11:49:59Z', labels: { 'foundry.interview-execution': 'true' } };
  it('selects only Foundry execution containers strictly older than ten minutes', () => {
    expect(orphanCandidates([container], now)).toEqual([container]);
    expect(orphanCandidates([{ ...container, createdAt: '2026-10-09T11:50:00Z' }], now)).toEqual([]);
  });
  it('never selects unrelated labels/names, young/future containers, or malformed metadata', () => {
    const excluded = [{ ...container, labels: {} }, { ...container, labels: { 'foundry.interview-execution': 'false' } }, { ...container, name: '/unrelated-database' }, { ...container, createdAt: '2026-10-09T11:59:00Z' }, { ...container, createdAt: '2026-10-09T12:30:00Z' }, { ...container, createdAt: 'invalid' }, { ...container, id: '--unsafe-argument' }];
    expect(orphanCandidates(excluded, now)).toEqual([]);
  });
});
