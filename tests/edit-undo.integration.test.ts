import { completeFixtureJob } from './inference-fixtures';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { withDisposablePostgres } from '../scripts/operations/disposable-postgres';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { getScenario } from '../lib/content/scenarios';

describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== '1')('accepted edit undo in disposable PostgreSQL', () => {
  it('persists restoration and acceptance history across adapters, and replays without overwriting later work', async () => {
    await withDisposablePostgres(async database => {
      const owner = randomUUID(); await database.admin.query('insert into auth.users(id) values($1)', [owner]);
      const service = new SessionService(new PostgresPracticeStore(database.service), getScenario);
      const base = (await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
      await service.requestAssistant(owner, base.id, { requestId: randomUUID(), expectedRevision: base.revision, mode: 'edit', message: 'Synthetic SQL edit fixture' });
      const claim = (await service.claimJob('undo-fixture-worker'))!;
      await completeFixtureJob(service, claim, { kind: 'assistant', message: 'Synthetic change', files: { 'quote.py': '# SQL proposed change' }, model: 'fixture', actualUsd: 0 });
      let current = await service.getSession(owner, base.id); const proposalId = current.editProposals[0].id;
      current = (await service.decideEdit(owner, base.id, { requestId: randomUUID(), expectedRevision: current.revision, proposalId, decision: 'accept' })).session;
      const before = await service.exportSession(owner, base.id), request = { requestId: randomUUID(), expectedRevision: current.revision, proposalId };
      const restored = await service.undoEdit(owner, base.id, request);
      const restarted = new SessionService(new PostgresPracticeStore(database.service), getScenario);
      const saved = await restarted.exportSession(owner, base.id);
      expect(saved.files).toEqual(base.files);
      expect(saved.snapshots.slice(0, -1)).toEqual(before.snapshots);
      expect(saved.events.slice(0, -1)).toEqual(before.events);
      expect(saved.editProposals[0]).toMatchObject({ status: 'accepted', decidedAt: current.editProposals[0].decidedAt, undoneAt: expect.any(String), undoSnapshotId: saved.snapshots.at(-1)!.id });
      expect(saved.jobs).toEqual(before.jobs);
      const later = (await restarted.saveWorkspace(owner, base.id, { requestId: randomUUID(), expectedRevision: restored.session.revision, files: { ...base.files, 'quote.py': '# Later acknowledged SQL work' } })).session;
      expect(await restarted.undoEdit(owner, base.id, request)).toEqual(restored);
      expect((await service.getSession(owner, base.id)).files).toEqual(later.files);
      await expect(restarted.undoEdit(owner, base.id, { ...request, requestId: randomUUID(), expectedRevision: later.revision })).rejects.toMatchObject({ code: 'not_found' });
      expect((await database.service.query('select count(*)::int as count from public.ai_practice_snapshots')).rows[0].count).toBe(4);
    });
  }, 60_000);
});
