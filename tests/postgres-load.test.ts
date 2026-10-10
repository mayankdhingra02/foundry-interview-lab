import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresPracticeStore, type PostgresStoreOptions } from '../lib/server/postgres-store';
import type { PracticeDatabase } from '../lib/interview-practice/types';
import { harness, openCase, owner, requestId, scenario } from './review-fixtures';

const baselineTables = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests'];
const reviewTables = ['ai_practice_review_cases','ai_practice_correction_drafts','ai_practice_correction_decisions','ai_practice_correction_publications','ai_practice_review_audits'];
type Row = Record<string, unknown> & { runtime_payload: unknown };
type Preflight = { table_name: string; bytes: string; count: string };
type Tagged = { table_name: string; entity: Row };
type TransportOptions = { reviewReady?: boolean; limits?: PostgresStoreOptions; sizes?: (rows: Preflight[], call: number) => Preflight[]; entities?: (rows: Tagged[]) => Tagged[] };

// A fake transport tests roundtrip count and fail-closed control flow, not SQL execution or latency.
function transport(records: Record<string, Row[]> = {}, options: TransportOptions = {}) {
  const present = [...baselineTables, ...(options.reviewReady ? reviewTables : [])];
  let preflightCalls = 0;
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    void parameters;
    if (sql.includes('to_regclass')) return { rows: [{ table_name: options.reviewReady ? 'ai_practice_review_cases' : null }] };
    if (sql.includes('as bytes')) {
      const sizes = present.map(table => ({ table_name: table, bytes: String((records[table] ?? []).reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row.runtime_payload)), 0)), count: String((records[table] ?? []).length) }));
      return { rows: options.sizes?.(sizes, ++preflightCalls) ?? sizes };
    }
    if (sql.includes('to_jsonb(entity)')) {
      const rows = present.flatMap(table_name => (records[table_name] ?? []).map(entity => ({ table_name, entity: structuredClone(entity) })));
      return { rows: options.entities?.(rows) ?? rows };
    }
    return { rows: [] };
  });
  const release = vi.fn(), pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { store: new PostgresPracticeStore(pool, options.limits), query, release };
}
async function fixture(reviews = false) {
  const context = harness(), created = (await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
  if (reviews) await openCase(context, created.id);
  const db = await context.store.read(), session = db.sessions[created.id];
  const { files: _files, snapshots: _snapshots, events: _events, jobs: _jobs, reports: _reports, turns: _turns, runs: _runs, assistantMessages: _messages, editProposals: _edits, frozenEvidence: _frozen, ...metadata } = session;
  void _files; void _snapshots; void _events; void _jobs; void _reports; void _turns; void _runs; void _messages; void _edits; void _frozen;
  const records: Record<string, Row[]> = {
    ai_practice_sessions: [{ id: session.id, user_id: owner, scenario_id: session.scenarioId, scenario_version: session.scenarioVersion, revision: session.revision, lifecycle: session.lifecycle, runtime_payload: metadata }],
    ai_practice_snapshots: session.snapshots.map(item => ({ id: item.id, session_id: session.id, user_id: owner, sequence: item.sequence, content_sha256: item.sha256, runtime_payload: item })),
    ai_practice_events: session.events.map(item => ({ id: item.id, session_id: session.id, user_id: owner, sequence: item.sequence, event_type: item.type, source: item.source, request_id: item.requestId, schema_version: item.schemaVersion, payload: item.payload, runtime_payload: item })),
    ai_practice_requests: Object.values(db.requests).map(item => ({ user_id: item.ownerId, request_id: item.requestId, fingerprint: item.fingerprint, runtime_payload: item })),
    ai_practice_usage_ledger: db.ledger.map(item => ({ id: item.id, user_id: item.ownerId, operation_id: item.operationId, runtime_payload: item })),
    ai_practice_review_cases: Object.values(db.reviews?.cases ?? {}).map(item => ({ id: item.id, user_id: item.ownerId, session_id: item.sessionId, report_id: item.reportId, status: item.status, revision: item.revision, inspection_consent: item.inspectionConsent, support_actions_consent: item.supportActionsConsent, runtime_payload: item })),
    ai_practice_review_audits: (db.reviews?.audits ?? []).map(item => ({ id: item.id, user_id: item.ownerId ?? null, session_id: item.sessionId ?? null, case_id: item.caseId ?? null, runtime_payload: item })),
  };
  return { records, db, session };
}
describe('batched PostgreSQL load transport and capacity preflight', () => {
  it('loads all baseline entities in three load requests and preserves the normalized representation', async () => {
    const { records, db } = await fixture(), { store, query, release } = transport(records);
    const result = await store.read(); expect(result).toEqual(db);
    expect(query).toHaveBeenCalledTimes(6); // BEGIN, setup, discovery, preflight, tagged rows, COMMIT.
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql[0]).toBe('begin isolation level repeatable read read only'); expect(sql.at(-1)).toBe('commit');
    expect(sql.filter(text => text.includes('as bytes'))).toHaveLength(1); expect(sql.filter(text => text.includes('to_jsonb(entity)'))).toHaveLength(1);
    for (const table of baselineTables) { expect(sql[3]).toContain(`from public.${table}`); expect(sql[4]).toContain(`from public.${table}`); }
    expect(sql[3]).not.toContain('PRIVATE-'); expect(sql[4]).not.toContain('PRIVATE-'); expect(release).toHaveBeenCalledOnce();
  });
  it('adds the review tables to the same two batches without extra table roundtrips', async () => {
    const { records, db } = await fixture(true), { store, query } = transport(records, { reviewReady: true });
    expect(await store.read()).toEqual(db); expect(query).toHaveBeenCalledTimes(6);
    const statements = query.mock.calls.map(call => call[0]);
    for (const table of reviewTables) { expect(statements[3]).toContain(`from public.${table}`); expect(statements[4]).toContain(`from public.${table}`); }
  });
  it('rejects total payload overflow before requesting any private entity rows', async () => {
    const { store, query, release } = transport({}, { limits: { maxStateBytes: 20 }, sizes: rows => rows.map((row,index) => ({ ...row, bytes: index < 2 ? '11' : '0' })) });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(call => call[0].includes('to_jsonb(entity)'))).toBe(false); expect(query.mock.calls.at(-1)?.[0]).toBe('rollback'); expect(release).toHaveBeenCalledOnce();
  });
  it('enforces per-table row caps independently of total bytes', async () => {
    const { store, query } = transport({}, { limits: { maxEntityRows: 1 }, sizes: rows => rows.map((row,index) => ({ ...row, count: index === 5 ? '2' : '0' })) });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' }); expect(query.mock.calls.some(call => call[0].includes('to_jsonb(entity)'))).toBe(false);
  });
  it.each(['missing','duplicate','unknown','invalid-count'] as const)('fails closed on %s preflight metadata', async kind => {
    const { store, query } = transport({}, { sizes: rows => kind === 'missing' ? rows.slice(1) : kind === 'duplicate' ? [...rows,rows[0]] : rows.map((row,index) => index ? row : { ...row, ...(kind === 'unknown' ? { table_name: 'caller_selected_table' } : { count: 'NaN' }) }) });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' }); expect(query.mock.calls.some(call => call[0].includes('to_jsonb(entity)'))).toBe(false);
  });
  it('rejects a row transfer inconsistent with preflight rather than returning truncated data', async () => {
    const { records } = await fixture(), { store } = transport(records, { entities: rows => rows.filter(row => row.table_name !== 'ai_practice_events') });
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('rejects unrecognized tags and malformed typed row payloads', async () => {
    const { records } = await fixture();
    for (const entities of [(rows: Tagged[]) => [{ ...rows[0], table_name: 'other_table' },...rows.slice(1)], (rows: Tagged[]) => [{ ...rows[0], entity: { runtime_payload: null } },...rows.slice(1)]]) {
      await expect(transport(records, { entities }).store.read()).rejects.toMatchObject({ code: 'unavailable' });
    }
  });
  it('retains event identity and snapshot-hash validation after batching', async () => {
    const { records } = await fixture(), corrupted = structuredClone(records);
    corrupted.ai_practice_events[0].event_type = 'session.paused'; await expect(transport(corrupted).store.read()).rejects.toMatchObject({ code: 'unavailable' });
    const changedSnapshot = structuredClone(records); changedSnapshot.ai_practice_snapshots[0].content_sha256 = '0'.repeat(64);
    await expect(transport(changedSnapshot).store.read()).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('keeps the transaction advisory lock ahead of preflight and does not narrow write locking', async () => {
    const { store, query } = transport(); expect(await store.transaction((db: PracticeDatabase) => db.schemaVersion)).toBe(1);
    const sql = query.mock.calls.map(call => call[0]); expect(sql[0]).toBe('begin');
    expect(sql.findIndex(text => text.includes('pg_advisory_xact_lock'))).toBeLessThan(sql.findIndex(text => text.includes('as bytes')));
    expect(query.mock.calls.find(call => call[0].includes('pg_advisory_xact_lock'))?.[1]).toEqual([843_239_117]); expect(sql.at(-1)).toBe('commit');
    expect(sql.filter(text => text.includes('as bytes'))).toHaveLength(2); // Load and pre-COMMIT use exactly the same metric.
  });
  it('rejects projected per-table growth before sending any entity write', async () => {
    const { store, query } = transport({}, { limits: { maxEntityRows: 1 } });
    await expect(store.transaction(db => { db.ledger = [0,1].map(index => ({ id: `row-${index}`, ownerId: owner, sessionId: 'session', operationId: `op-${index}`, kind: 'admission', amountUsd: 0, createdAt: '2026-10-09T12:00:00.000Z' })); })).rejects.toMatchObject({ code: 'unavailable' });
    const sql = query.mock.calls.map(call => call[0]); expect(sql.some(text => /^(insert|delete|update) /i.test(text))).toBe(false);
    expect(sql.at(-1)).toBe('rollback');
  });
  it.each(['bytes','count'] as const)('rolls back when the exact persisted %s metric crosses the cap', async metric => {
    const { store, query, release } = transport({}, { limits: { maxStateBytes: 1000, maxEntityRows: 1 }, sizes: (rows, call) => call === 1 ? rows : rows.map((row,index) => index ? row : { ...row, [metric]: metric === 'bytes' ? '1001' : '2' }) });
    await expect(store.transaction(db => db.schemaVersion)).rejects.toMatchObject({ code: 'unavailable' });
    const sql = query.mock.calls.map(call => call[0]);
    expect(sql.filter(text => text.includes('as bytes'))).toHaveLength(2);
    expect(sql.filter(text => text.includes('as bytes'))[0]).toBe(sql.filter(text => text.includes('as bytes'))[1]);
    expect(sql).not.toContain('commit'); expect(sql.at(-1)).toBe('rollback'); expect(release).toHaveBeenCalledOnce();
  });
  it('rechecks all optional review tables in one pre-COMMIT request', async () => {
    const { store, query } = transport({}, { reviewReady: true }); await store.transaction(db => db.schemaVersion);
    const batches = query.mock.calls.map(call => call[0]).filter(text => text.includes('as bytes'));
    expect(batches).toHaveLength(2); expect(batches[1]).toBe(batches[0]);
    expect(query.mock.calls.filter(call => call[0].includes('to_regclass'))).toHaveLength(1);
    for (const table of reviewTables) expect(batches[1]).toContain(`from public.${table}`);
  });
});
