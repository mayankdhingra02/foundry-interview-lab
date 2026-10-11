import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { readySchema } from './readiness-fixtures';

const boundary = { ledgerPoliciesPrivate: true, ledgerNoCurrentTruncate: true, closingPoliciesPrivate: true, closingNoRemoval: true, closingCleanupRestricted: true };
function transport(options: { schema?: ReturnType<typeof readySchema>; boundary?: Record<string, unknown>; lock?: number } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('as "foreignKeyCount"')) return { rows: options.schema ?? readySchema() };
    if (sql.includes('as "ledgerPoliciesPrivate"')) return { rows: [options.boundary ?? boundary] };
    if (sql.includes('to_regclass')) return { rows: [{ table_name: 'ai_practice_review_cases', closing_table: 'ai_practice_account_closings' }] };
    if (sql.includes('as bytes')) return { rows: [...sql.matchAll(/select '([a-z_]+)'::text as table_name/g)].map(([, table_name]) => ({ table_name, count: '0', bytes: '0' })) };
    return { rows: [] };
  });
  const release = vi.fn(), store = new PostgresPracticeStore({ connect: async () => ({ query, release }) } as unknown as Pool, options.lock ? { advisoryLockKey: options.lock } : {});
  return { store, query, release };
}

describe('transaction-only private cleanup live schema boundary', () => {
  it('requires the current protected transaction and checks catalogs before returning', async () => {
    const { store, query } = transport();
    await expect(store.assertPrivateCleanupReady()).rejects.toMatchObject({ code: 'unavailable' }); expect(query).not.toHaveBeenCalled();
    await store.transaction(() => store.assertPrivateCleanupReady());
    const calls = query.mock.calls.map(([sql]) => sql);
    expect(calls.findIndex(sql => sql.includes('pg_advisory_xact_lock'))).toBeLessThan(calls.findIndex(sql => sql.includes('as "foreignKeyCount"')));
    expect(calls).toContain('commit'); expect(calls.some(sql => /^(insert|update|delete) /i.test(sql))).toBe(false);
    expect(calls.find(sql => sql.includes('as "closingCleanupRestricted"'))).toContain("c.confdeltype='r'");
  });
  it('rejects an alternative advisory lock protocol', async () => {
    const { store, query } = transport({ lock: 123 });
    await expect(store.transaction(() => store.assertPrivateCleanupReady())).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(([sql]) => sql.includes('as "foreignKeyCount"'))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });
  it.each(Object.keys(boundary))('fails closed when the catalog boundary %s is absent, false or untrusted', async key => {
    for (const value of [false, undefined, 'true']) {
      const { store, query } = transport({ boundary: { ...boundary, [key]: value } });
      await expect(store.transaction(() => store.assertPrivateCleanupReady())).rejects.toMatchObject({ code: 'unavailable' });
      expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
    }
  });
  it.each(['ai_practice_account_closings', 'ai_practice_sessions', 'ai_practice_jobs', 'ai_practice_snapshots', 'ai_practice_artifacts'])('rejects a disabled live closing guard on %s', async name => {
    const schema = readySchema(); schema.find(row => row.name === name)!.triggers.find(trigger => trigger.procedure !== 'ai_practice_reject_immutable_update')!.enabled = 'D';
    const { store, query } = transport({ schema });
    await expect(store.transaction(() => store.assertPrivateCleanupReady())).rejects.toMatchObject({ code: 'unavailable' });
    expect(query.mock.calls.some(([sql]) => sql.includes('as "ledgerPoliciesPrivate"'))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('rollback');
  });
  it('rejects private column access before evaluating the destructive boundary', async () => {
    const schema = readySchema(); schema.find(row => row.name === 'ai_practice_deletions')!.authenticatedSelect = true;
    const { store } = transport({ schema });
    await expect(store.transaction(() => store.assertPrivateCleanupReady())).rejects.toMatchObject({ code: 'unavailable' });
  });
});
