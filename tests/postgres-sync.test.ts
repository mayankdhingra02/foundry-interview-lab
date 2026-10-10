import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { getScenario } from '../lib/content/scenarios';
import { requestKey } from '../lib/interview-practice/domain';
import type { PracticeDatabase } from '../lib/interview-practice/types';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';

const tables = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests'];
type Row = Record<string, unknown> & { runtime_payload: unknown };
type Package = { scenario_id: string; version: string; manifest_sha256: string };

async function fixture(result?: unknown) {
  const owner = randomUUID(), memory = new MemoryPracticeStore(), service = new SessionService(memory, getScenario);
  const created = await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() });
  const database = await memory.read(); const key = Object.keys(database.requests)[0];
  if (result !== undefined) database.requests[key].result = result;
  const session = database.sessions[created.session.id];
  const { files: _files, snapshots: _snapshots, events: _events, jobs: _jobs, reports: _reports, turns: _turns, runs: _runs, assistantMessages: _messages, editProposals: _edits, frozenEvidence: _manifest, ...metadata } = session;
  void _files; void _snapshots; void _events; void _jobs; void _reports; void _turns; void _runs; void _messages; void _edits; void _manifest;
  const rows: Record<string, Row[]> = {
    ai_practice_sessions: [{ id: session.id, user_id: owner, scenario_id: session.scenarioId, scenario_version: session.scenarioVersion, revision: session.revision, lifecycle: session.lifecycle, runtime_payload: metadata }],
    ai_practice_snapshots: session.snapshots.map(item => ({ id: item.id, session_id: session.id, user_id: owner, sequence: item.sequence, content_sha256: item.sha256, created_at: item.createdAt, runtime_payload: item })),
    ai_practice_events: session.events.map(item => ({ id: item.id, session_id: session.id, user_id: owner, sequence: item.sequence, event_type: item.type, source: item.source, request_id: item.requestId, schema_version: item.schemaVersion, payload: item.payload, runtime_payload: item })),
    ai_practice_requests: Object.values(database.requests).map(item => ({ user_id: item.ownerId, request_id: item.requestId, fingerprint: item.fingerprint, runtime_payload: item })),
    ai_practice_usage_ledger: database.ledger.map(item => ({ id: item.id, user_id: owner, operation_id: item.operationId, runtime_payload: item })),
  };
  let packages: Package[] = [];
  // This transport preserves projected JSON row shapes and records write
  // intentions. It does not execute SQL or establish a latency result.
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('to_regclass')) return { rows: [{ table_name: null }] };
    if (sql.includes('as bytes')) return { rows: tables.map(table_name => ({ table_name, count: String(rows[table_name]?.length ?? 0), bytes: String((rows[table_name] ?? []).reduce((sum,row) => sum + Buffer.byteLength(JSON.stringify(row.runtime_payload)),0)) })) };
    if (sql.includes('to_jsonb(entity)')) return { rows: [...sql.matchAll(/select '([a-z_]+)'::text as table_name, to_jsonb\(entity\) as entity from \(select ([a-z0-9_,]+) from public\.\1\) as entity/g)].flatMap(([,table_name,columns]) => (rows[table_name] ?? []).map(row => ({ table_name, entity: JSON.parse(JSON.stringify(Object.fromEntries(columns.split(',').map(column => [column,row[column]])))) }))) };
    if (sql.startsWith('insert into public.practice_scenario_versions')) { packages = JSON.parse(String(parameters![0])); return { rows: [] }; }
    if (sql.startsWith('select versions.scenario_id')) return { rows: packages.map(({ scenario_id,version,manifest_sha256 }) => ({ scenario_id,version,manifest_sha256 })) };
    return { rows: [] };
  });
  const store = new PostgresPracticeStore({ connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool);
  const writes = () => query.mock.calls.filter(([sql]) => /^(insert into|update|delete from) public\.ai_practice_/i.test(sql));
  return { store, query, writes, key, sessionId: session.id, owner };
}

describe('PostgreSQL unchanged entity sync and JSON persistence semantics', () => {
  it('keeps an unchanged cached full SessionView without issuing entity upserts', async () => {
    const { store, writes } = await fixture();
    await store.transaction(db => db.requests);
    expect(writes()).toEqual([]);
  });

  it('persists a changed nested cached response while leaving other entities untouched', async () => {
    const { store, writes, key } = await fixture();
    await store.transaction(db => { const result = db.requests[key].result as { session: { files: Record<string,string> } }; result.session.files[Object.keys(result.session.files)[0]] += '\n# Changed cached response\n'; });
    expect(writes()).toHaveLength(1); expect(writes()[0][0]).toContain('insert into public.ai_practice_requests');
    const parameters = writes()[0][1]!;
    expect(parameters.some(value => typeof value === 'string' && value.includes('# Changed cached response'))).toBe(true);
  });

  it('preserves JSON-normalized equality for optional keys, numeric values, arrays, and dates', async () => {
    const original = { data: { integer: 0, nonfinite: null, list: [null,0], when: '2026-10-09T00:00:00.000Z' }, label: 'same' };
    const { store, writes, key } = await fixture(original);
    await store.transaction(db => { db.requests[key].result = { label: 'same', absent: undefined, data: { when: new Date(original.data.when), list: [undefined,-0], nonfinite: NaN, integer: -0 } }; });
    expect(writes()).toEqual([]);
  });

  it('still persists array order changes and newly added cached requests', async () => {
    const { store, writes, key, owner, sessionId } = await fixture({ data: ['first','second'] });
    await store.transaction(db => {
      db.requests[key].result = { data: ['second','first'] };
      const requestId = randomUUID(); db.requests[requestKey(owner,requestId)] = { ownerId: owner, requestId, fingerprint: 'synthetic-fingerprint', result: { sessionId }, sessionId, createdAt: '2026-10-09T00:00:00.000Z' };
    });
    expect(writes()).toHaveLength(2); expect(writes().every(([sql]) => sql.startsWith('insert into public.ai_practice_requests'))).toBe(true);
  });

  it('deletes only the removed replay record with its composite owner/request identity', async () => {
    const { store, writes, key, owner } = await fixture();
    let removed = '';
    await store.transaction(db => { removed = db.requests[key].requestId; delete db.requests[key]; });
    expect(writes()).toHaveLength(1); expect(writes()[0]).toEqual(['delete from public.ai_practice_requests where user_id=$1 and request_id=$2',[owner,removed]]);
  });

  it('retains immutable snapshot validation before any entity write', async () => {
    const { store, writes, query, sessionId } = await fixture();
    await expect(store.transaction((db: PracticeDatabase) => { const files = db.sessions[sessionId].snapshots[0].files; files[Object.keys(files)[0]] += '\n# Attempted evidence rewrite\n'; })).rejects.toMatchObject({ code: 'conflict' });
    expect(writes()).toEqual([]); expect(query.mock.calls.at(-1)![0]).toBe('rollback');
  });
});
