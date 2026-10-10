import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { digest } from '../lib/interview-practice/domain';
import { getScenario } from '../lib/content/scenarios';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';

const tables = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests','ai_practice_account_closings'];
type Row = Record<string, unknown> & { runtime_payload: unknown };
function transport(options: { records?: Record<string, Row[]>; keys?: string[]; metadata?: { count: string; bytes: string; maximum: string }; closingReady?: boolean } = {}) {
  const records = options.records ?? {}, present = options.closingReady === false ? tables.slice(0, -1) : tables;
  const keys = options.keys ?? [];
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    void parameters;
    if (sql.includes('to_regclass')) return { rows: [{ table_name: null, closing_table: options.closingReady === false ? null : 'ai_practice_account_closings' }] };
    if (sql.includes('as maximum')) return { rows: [options.metadata ?? { count: String(keys.length), bytes: String(keys.join('').length), maximum: String(Math.max(0, ...keys.map(key => key.length))) }] };
    if (sql.startsWith('select storage_key')) return { rows: keys.map(storage_key => ({ storage_key })) };
    if (sql.includes('as bytes')) return { rows: present.map(table_name => ({ table_name, count: String(records[table_name]?.length ?? 0), bytes: String((records[table_name] ?? []).reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.runtime_payload)), 0)) })) };
    if (sql.includes('to_jsonb(entity)')) return { rows: present.flatMap(table_name => (records[table_name] ?? []).map(entity => ({ table_name, entity }))) };
    return { rows: [] };
  });
  const release = vi.fn(), store = new PostgresPracticeStore({ connect: async () => ({ query, release }) } as unknown as Pool);
  return { store, query, release };
}
function closingRecords() {
  const ownerId = randomUUID(), cleanupId = randomUUID(), createdAt = '2026-10-10T12:00:00.000Z';
  const cleanup = { id: cleanupId, ownerId, sessionId: cleanupId, state: 'completed', objectKeys: [], createdAt, completedAt: createdAt };
  const closing = { ownerId, cleanupId, requestId: randomUUID(), fingerprint: digest('fixed closing fixture'), createdAt };
  const records = {
    ai_practice_deletions: [{ id: cleanupId, opaque_owner_id: ownerId, runtime_payload: cleanup }],
    ai_practice_account_closings: [{ opaque_owner_id: ownerId, request_id: closing.requestId, fingerprint: closing.fingerprint, cleanup_id: cleanupId, created_at: createdAt, runtime_payload: closing }],
  };
  return { ownerId, cleanup, closing, records };
}

describe('account fence persistence and inventory bounds (fake PostgreSQL transport)', () => {
  it('loads relationally verified closing state and rejects old/new create keys before any insert', async () => {
    const fixture = closingRecords(), { store, query } = transport({ records: fixture.records });
    expect((await store.read()).accountClosings?.[fixture.ownerId]).toEqual(fixture.closing);
    const service = new SessionService(store, getScenario);
    await expect(service.createSession(fixture.ownerId, { scenarioId: 'monetary-validation', requestId: randomUUID() })).rejects.toMatchObject({ code: 'account_closing' });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('insert into'))).toBe(false);
  });

  it.each(['json', 'date'])('retains nonzero milliseconds in a %s relational timestamp', async encoding => {
    const fixture = closingRecords(), at = '2026-10-10T12:00:00.321Z';
    fixture.closing.createdAt = at;
    (fixture.records.ai_practice_account_closings[0] as Record<string, unknown>).created_at = encoding === 'date' ? new Date(at) : at.replace('Z', '+00:00');
    expect((await transport({ records: fixture.records }).store.read()).accountClosings?.[fixture.ownerId].createdAt).toBe(at);
  });

  it.each(['opaque_owner_id', 'request_id', 'fingerprint', 'cleanup_id', 'created_at'])('fails closed on a mismatched relational fence field %s', async column => {
    const fixture = closingRecords();
    (fixture.records.ai_practice_account_closings[0] as Record<string, unknown>)[column] = 'CORRUPT-PRIVATE-VALUE';
    const { store } = transport({ records: fixture.records });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('rejects a fence without its durable inventory and refuses normal fence removal', async () => {
    const fixture = closingRecords();
    await expect(transport({ records: { ...fixture.records, ai_practice_deletions: [] } }).store.read()).rejects.toMatchObject({ code: 'unavailable' });
    const { store, query } = transport({ records: fixture.records });
    await expect(store.transaction(database => { delete database.accountClosings![fixture.ownerId]; })).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(([sql]) => /^(insert into|delete from)/.test(sql))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });

  it('persists inventory before the fence in the same advisory transaction and never writes an Auth-bound request cache', async () => {
    const { store, query, release } = transport({ keys: ['synthetic/private-key'] });
    const owner = randomUUID(), result = await new SessionService(store, getScenario).closeAccount(owner, { requestId: randomUUID() });
    expect(result).toMatchObject({ closed: true, cleanupState: 'pending' });
    const calls = query.mock.calls.map(([sql]) => sql);
    expect(query).toHaveBeenCalledWith('select pg_advisory_xact_lock($1)', [843_239_117]);
    expect(calls.findIndex(sql => sql.startsWith('insert into public.ai_practice_deletions'))).toBeLessThan(calls.findIndex(sql => sql.startsWith('insert into public.ai_practice_account_closings')));
    expect(calls.some(sql => sql.startsWith('insert into public.ai_practice_requests'))).toBe(false);
    expect(calls.at(-1)).toBe('commit'); expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { count: '1001', bytes: '1001', maximum: '1' },
    { count: '1', bytes: '200001', maximum: '2048' },
    { count: '1', bytes: '2049', maximum: '2049' },
    { count: 'invalid', bytes: '0', maximum: '0' },
  ])('rejects unsafe inventory metadata before transferring object keys: %j', async metadata => {
    const { store, query } = transport({ metadata });
    await expect(new SessionService(store, getScenario).closeAccount(randomUUID(), { requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('select storage_key'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.startsWith('insert into'))).toBe(false);
  });

  it('rejects inventory count drift and transaction-only capture outside the protected callback', async () => {
    const { store, query } = transport({ keys: ['synthetic/key'], metadata: { count: '0', bytes: '0', maximum: '0' } });
    await expect(store.captureOwnerObjectKeys(randomUUID())).rejects.toMatchObject({ code: 'unavailable' }); expect(query).not.toHaveBeenCalled();
    await expect(new SessionService(store, getScenario).closeAccount(randomUUID(), { requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('insert into'))).toBe(false);
  });

  it('rejects permanent close before erasure when the append-only closing migration is absent', async () => {
    const { store, query } = transport({ closingReady: false });
    await expect(new SessionService(store, getScenario).closeAccount(randomUUID(), { requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(([sql]) => /^(insert into|delete from)/.test(sql))).toBe(false);
  });
});
