import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withDisposablePostgres } from '../scripts/operations/disposable-postgres';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { getScenario } from '../lib/content/scenarios';

describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== '1')('erased request replay in disposable PostgreSQL', () => {
  it('persists content-free markers across adapters without new admission or erasure of fresh attempts', async () => {
    await withDisposablePostgres(async database => {
      const owner = randomUUID(); await database.admin.query('insert into auth.users(id) values($1)', [owner]);
      const service = new SessionService(new PostgresPracticeStore(database.service), getScenario);
      const input = { scenarioId: 'monetary-validation', requestId: randomUUID() };
      const session = (await service.createSession(owner, input)).session;
      await service.saveWorkspace(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# PRIVATE-ERASED-SQL' } });
      await service.deleteSession(owner, session.id, { requestId: randomUUID() });
      const restarted = new SessionService(new PostgresPracticeStore(database.service), getScenario);
      await expect(restarted.createSession(owner, input)).rejects.toMatchObject({ code: 'request_deleted', status: 410 });
      expect((await database.service.query("select count(*)::int as count from public.ai_practice_usage_ledger where kind='admission'")).rows[0].count).toBe(1);
      const tombstone = (await database.service.query('select runtime_payload from public.ai_practice_deletions')).rows;
      expect(JSON.stringify(tombstone)).toContain(input.requestId); expect(JSON.stringify(tombstone)).not.toContain('PRIVATE-ERASED-SQL');
      expect((await database.service.query('select count(*)::int as count from public.ai_practice_snapshots')).rows[0].count).toBe(0);
      const firstDelete = { requestId: randomUUID() };
      await restarted.createSession(owner, { ...input, requestId: randomUUID() });
      await restarted.deleteAccount(owner, firstDelete);
      await restarted.createSession(owner, { ...input, requestId: randomUUID() });
      await restarted.deleteAccount(owner, { requestId: randomUUID() });
      const fresh = (await restarted.createSession(owner, { ...input, requestId: randomUUID() })).session;
      await expect(service.deleteAccount(owner, firstDelete)).rejects.toMatchObject({ code: 'request_deleted' });
      expect((await service.getSession(owner, fresh.id)).id).toBe(fresh.id);
    });
  }, 60_000);
});
