import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { getScenario } from '../lib/content/scenarios';
import { MemoryPracticeStore } from '../lib/server/store';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';

type Package = { scenario_id: string; version: string; manifest: unknown; manifest_sha256: string };
const tables = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests'];
async function corpus(count = 10, different = false) {
  const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario);
  for (let index = 0; index < count; index++) await service.createSession(randomUUID(), { scenarioId: different && index % 2 ? 'event-rollup' : 'monetary-validation', requestId: randomUUID() });
  return store.read();
}
function fixture(alter?: (packages: Package[]) => unknown[]) {
  let admitted: Package[] = [];
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('to_regclass')) return { rows: [{ table_name: null }] };
    if (sql.includes('as bytes')) return { rows: tables.map(table_name => ({ table_name, count: '0', bytes: '0' })) };
    if (sql.startsWith('insert into public.practice_scenario_versions')) { admitted = JSON.parse(String(parameters![0])); return { rows: [] }; }
    if (sql.startsWith('select versions.scenario_id')) return { rows: alter?.(admitted) ?? admitted.map(({ scenario_id, version, manifest_sha256 }) => ({ scenario_id, version, manifest_sha256 })) };
    return { rows: [] };
  });
  const store = new PostgresPracticeStore({ connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool);
  return { store, query };
}

describe('batched immutable scenario registry validation', () => {
  it('uses two scenario registry requests for ten sessions sharing the same package', async () => {
    const data = await corpus(), { store, query } = fixture();
    await store.transaction(db => Object.assign(db, data));
    const manifestQueries = query.mock.calls.filter(([sql]) => sql.includes('practice_scenario_versions'));
    expect(manifestQueries).toHaveLength(2);
    expect(JSON.parse(String(manifestQueries[0][1]![0]))).toHaveLength(1);
    expect(manifestQueries[0][0]).toContain('where true on conflict');
    expect(query.mock.calls.at(-1)![0]).toBe('commit');
  });
  it('validates every distinct package/version with one parameterized batch', async () => {
    const data = await corpus(10, true), { store, query } = fixture();
    await store.transaction(db => Object.assign(db, data));
    const insert = query.mock.calls.find(([sql]) => sql.startsWith('insert into public.practice_scenario_versions'))!;
    expect(JSON.parse(String(insert[1]![0])).map((p: Package) => p.scenario_id).sort()).toEqual(['event-rollup', 'monetary-validation']);
    expect(insert[0]).not.toContain('Monetary'); expect(insert[1]).toHaveLength(1);
  });
  for (const kind of ['wrong-hash', 'missing', 'duplicate', 'unknown'] as const) it(`rolls back ${kind} registry evidence`, async () => {
    const data = await corpus(2, true), { store, query } = fixture(packages => {
      const rows = packages.map(({ scenario_id, version, manifest_sha256 }) => ({ scenario_id, version, manifest_sha256 }));
      if (kind === 'missing') return rows.slice(1);
      if (kind === 'duplicate') return [...rows, rows[0]];
      return rows.map((row,index) => index ? row : { ...row, ...(kind === 'wrong-hash' ? { manifest_sha256: '0'.repeat(64) } : { scenario_id: 'not-admitted' }) });
    });
    await expect(store.transaction(db => Object.assign(db, data))).rejects.toMatchObject({ code: 'conflict' });
    expect(query.mock.calls.at(-1)![0]).toBe('rollback');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('insert into public.ai_practice_sessions'))).toBe(false);
  });
  it('rejects inconsistent same-version packages within the proposed corpus before registry writes', async () => {
    const data = await corpus(2), sessions = Object.values(data.sessions); sessions[1].scenario.summary += ' changed';
    const { store, query } = fixture();
    await expect(store.transaction(db => Object.assign(db, data))).rejects.toMatchObject({ code: 'conflict' });
    expect(query.mock.calls.some(([sql]) => sql.includes('practice_scenario_versions'))).toBe(false);
  });
});
