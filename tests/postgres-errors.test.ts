import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { DomainError } from '../lib/interview-practice/domain';
import { HttpError } from '../lib/server/http';
import { PostgresPracticeStore } from '../lib/server/postgres-store';

// Supports both the original and batched load transport, keeping this regression
// independent from the subsequent loader optimization.
function emptyTransport() {
  const tables = ['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions','ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests'];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('to_regclass')) return { rows: [{ table_name: null }] };
    if (sql.includes('as bytes')) return { rows: sql.includes('union all') ? tables.map(table_name => ({ table_name, bytes: '0', count: '0' })) : [{ bytes: '0', count: '0' }] };
    return { rows: [] };
  });
  const release = vi.fn(), pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
  return { store: new PostgresPracticeStore(pool), query, release };
}
describe('trusted PostgreSQL callback errors and safe storage failures', () => {
  it('preserves an actual support consent HttpError after rollback', async () => {
    const { store, query, release } = emptyTransport(), denied = new HttpError(403, 'support_consent_required', 'Current learner permission is required.');
    await expect(store.transaction(() => { throw denied; })).rejects.toBe(denied);
    expect(query.mock.calls.at(-1)?.[0]).toBe('rollback'); expect(release).toHaveBeenCalledOnce();
  });
  it('preserves safe domain conflicts and quota errors', async () => {
    const { store } = emptyTransport(), conflict = new DomainError('conflict', 'A newer published report exists.');
    await expect(store.transaction(() => { throw conflict; })).rejects.toBe(conflict);
  });
  it('redacts unknown SQL errors even when they imitate status/code/message fields', async () => {
    const { store } = emptyTransport();
    const sql = Object.assign(new Error('PRIVATE SQL DETAIL postgres://password@host learner-code'), { code: '23514', status: 403 });
    let caught: unknown; try { await store.transaction(() => { throw sql; }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'unavailable', status: 503 }); expect(String(caught)).not.toContain('PRIVATE'); expect(String(caught)).not.toContain('password');
  });
  it('does not preserve plain objects masquerading as safe HTTP errors', async () => {
    const { store } = emptyTransport();
    await expect(store.transaction(() => { throw { status: 403, code: 'forged', message: 'PRIVATE DATA' }; })).rejects.toMatchObject({ code: 'unavailable', status: 503 });
  });
  it('redacts read connection failures while releasing an acquired client after a failed query', async () => {
    const { store, query, release } = emptyTransport(); query.mockRejectedValueOnce(new Error('PRIVATE DATABASE CONNECTION'));
    await expect(store.read()).rejects.toMatchObject({ code: 'unavailable', status: 503 }); expect(release).toHaveBeenCalledOnce();
  });
});
