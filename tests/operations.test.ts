import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { operationalCounters, orphanCandidates, probeReadiness, recordWorkerHeartbeat, setExecutionAdmission } from '../lib/server/operations';
import type { ContainerMetadata } from '../lib/server/operations';
import { readinessSchemaQuery } from '../lib/server/readiness-schema';
import { readySchema } from './readiness-fixtures';

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
    const db = queryPort([[], []]);
    expect((await probeReadiness(db)).checks.schema).toBe('missing');
    expect(db.query).toHaveBeenCalledTimes(2);
  });
  it('requires a fresh worker and available required execution runtime', async () => {
    const db = queryPort([[], readySchema(), [{ fresh: false, runner_ready: false }], [{ blocked: false }]]);
    const result = await probeReadiness(db);
    expect(result.status).toBe('not_ready');
    expect(result.checks.worker).toBe('stale');
    expect(result.checks.execution).toBe('unavailable');
  });
  it('is ready when durable schema, worker freshness, runtime and shared admission agree', async () => {
    const db = queryPort([[], readySchema(), [{ fresh: true, runner_ready: true }], [{ blocked: false }]]);
    expect((await probeReadiness(db)).status).toBe('ready');
  });
  it('does not admit a deployment with missing identity/origin configuration', async () => {
    const db = queryPort([[], readySchema(), [{ fresh: true, runner_ready: true }], [{ blocked: false }]]);
    const result = await probeReadiness(db, { configurationReady: false });
    expect(result.status).toBe('not_ready');
    expect(result.checks.configuration).toBe('unconfigured');
  });
  it('does not require Docker when execution is deliberately disabled', async () => {
    const db = queryPort([[], readySchema(), [{ fresh: true, runner_ready: false }]]);
    const result = await probeReadiness(db, { executionRequired: false });
    expect(result.status).toBe('ready');
    expect(result.checks.execution).toBe('disabled');
  });
  it('keeps shared cleanup holds closed even with a healthy worker', async () => {
    const db = queryPort([[], readySchema(), [{ fresh: true, runner_ready: true }], [{ blocked: true }]]);
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

describe('release schema capabilities before readiness', () => {
  const baseline = () => readySchema().filter(row => !row.name.startsWith('practice_billing_') && !/ai_practice_(review_|correction_)/.test(row.name));
  const probe = async (rows: ReturnType<typeof readySchema>, requiredFeatures = {}) => {
    const db = queryPort([[], rows, [{ fresh: true, runner_ready: true }], [{ blocked: false }]]);
    return { result: await probeReadiness(db, { requiredFeatures }), db };
  };
  it('rejects the original five-table presence check and stops before worker checks', async () => {
    const names = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_jobs','practice_worker_heartbeats','practice_operations_state'];
    const { result, db } = await probe(readySchema().filter(row => names.includes(row.name)));
    expect(result.checks.schema).toBe('missing'); expect(result.status).toBe('not_ready'); expect(db.query).toHaveBeenCalledTimes(2);
  });
  it.each(['ai_practice_runs','ai_practice_events','ai_practice_usage_ledger','ai_practice_requests'])('requires runtime child %s', async name => {
    expect((await probe(readySchema().filter(row => row.name !== name))).result.checks.schema).toBe('missing');
  });
  it('rejects absent or wrongly typed runtime columns despite all table names being present', async () => {
    const rows = readySchema(), sessions = rows.find(row => row.name === 'ai_practice_sessions')!;
    delete sessions.columns.runtime_payload;
    expect((await probe(rows)).result.checks.schema).toBe('missing');
    sessions.columns.runtime_payload = 'text';
    expect((await probe(rows)).result.checks.schema).toBe('missing');
  });
  it.each(['anonymousSelect','authenticatedSelect','clientWrites'])('rejects unsafe private-job %s privileges, including effective column grants', async privilege => {
    const rows = readySchema(); Object.assign(rows.find(row => row.name === 'ai_practice_jobs')!, { [privilege]: true });
    expect((await probe(rows)).result.checks.schema).toBe('missing');
  });
  it('requires row security, trusted access and enabled immutable evidence triggers', async () => {
    for (const mutation of [
      (row: ReturnType<typeof readySchema>[number]) => { row.rowSecurity = false; },
      (row: ReturnType<typeof readySchema>[number]) => { row.serviceAccess = false; },
      (row: ReturnType<typeof readySchema>[number]) => { row.currentAccess = false; },
      (row: ReturnType<typeof readySchema>[number]) => { row.currentBypass = false; },
      (row: ReturnType<typeof readySchema>[number]) => { row.serviceBypass = false; },
      (row: ReturnType<typeof readySchema>[number]) => { row.triggers[0].enabled = 'D'; },
    ]) {
      const rows = readySchema(); mutation(rows.find(row => row.name === 'ai_practice_reports')!);
      expect((await probe(rows)).result.checks.schema).toBe('missing');
    }
  });
  it('rejects legacy, unvalidated, widened or unversioned event vocabulary', async () => {
    for (const replace of [
      (definition: string) => definition.replace("'assistant.edit-proposed'::text, ", ''),
      (definition: string) => definition.replace("'assistant.edit-proposed'::text", "'invented'::text"),
      (definition: string) => definition.replace('schema_version = 1', 'schema_version >= 1'),
      (definition: string) => `${definition} OR true`,
    ]) {
      const rows = readySchema(), check = rows.find(row => row.name === 'ai_practice_events')!.checks[0]; const before = check.definition; check.definition = replace(before);
      expect(check.definition).not.toBe(before);
      expect((await probe(rows)).result.checks.schema).toBe('missing');
    }
    const rows = readySchema(); rows.find(row => row.name === 'ai_practice_events')!.checks[0].validated = false;
    expect((await probe(rows)).result.checks.schema).toBe('missing');
  });
  it('keeps absent optional schemas compatible and requires configured or partially present features', async () => {
    expect((await probe(baseline())).result.status).toBe('ready');
    expect((await probe(baseline(), { reviews: true })).result.checks.schema).toBe('missing');
    expect((await probe(baseline(), { billing: true })).result.checks.schema).toBe('missing');
    expect((await probe([...baseline(), readySchema().find(row => row.name === 'ai_practice_review_cases')!])).result.checks.schema).toBe('missing');
    const rows = baseline(); rows.find(row => row.name === 'ai_practice_usage_ledger')!.checks = [];
    expect((await probe(rows, { voice: true })).result.checks.schema).toBe('missing');
    expect((await probe(readySchema(), { reviews: true, billing: true, voice: true })).result.status).toBe('ready');
  });
  it('queries bounded catalog metadata and exposes only the existing safe schema status', async () => {
    const rows = readySchema(); rows.find(row => row.name === 'ai_practice_jobs')!.authenticatedSelect = true;
    const { result, db } = await probe(rows);
    expect(vi.mocked(db.query).mock.calls[1][0]).toBe(readinessSchemaQuery);
    expect(readinessSchemaQuery).not.toMatch(/from public\.|select \*/i);
    expect(readinessSchemaQuery).toContain('has_any_column_privilege');
    expect(JSON.stringify(result)).not.toMatch(/ai_practice|runtime_payload|authenticated|grant|column/);
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
