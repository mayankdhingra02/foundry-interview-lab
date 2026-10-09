import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { LEARNER_CHECK_POLICY as policy } from '../lib/interview-practice/check-policy';
import { digest, textDigest } from '../lib/interview-practice/domain';
import { freezeEvidence } from '../lib/interview-practice/evidence';
import { SessionService } from '../lib/server/session-service';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { withDisposablePostgres } from '../scripts/operations/disposable-postgres';
import { fixtureRuntimeId } from './runtime-fixtures';

describe.runIf(process.env.RUN_POSTGRES_INTEGRATION === '1')('learner check normalized persistence in a disposable database', () => {
  it('preserves old snapshots, immutable source admission, owner privacy and separate evidence after restart', async () => {
    await withDisposablePostgres(async database => {
      const owner = randomUUID(), stranger = randomUUID(), scenario = getScenario('monetary-validation')!;
      await database.admin.query('insert into auth.users(id) values($1),($2)',[owner,stranger]);
      const store = new PostgresPracticeStore(database.service), service = new SessionService(store,getScenario);
      let session = (await service.createSession(owner,{ scenarioId: scenario.id,requestId: randomUUID() })).session;
      const oldSnapshot = (await service.exportSession(owner,session.id)).snapshots[0];
      const source = 'import unittest\nclass Regression(unittest.TestCase):\n    def test_sum(self): self.assertEqual(1 + 2, 3)\n';
      session = (await service.saveWorkspace(owner,session.id,{ requestId: randomUUID(),expectedRevision: session.revision,files: { ...session.files,[policy.path]: source } })).session;
      const input = { requestId: randomUUID(),expectedRevision: session.revision,selection: 'learner' as const };
      const acknowledged = await service.requestRun(owner,session.id,input);
      const restarted = new SessionService(new PostgresPracticeStore(database.service),getScenario);
      expect(await restarted.requestRun(owner,session.id,input)).toEqual(acknowledged);
      const saved = await restarted.exportSession(owner,session.id);
      expect(saved.snapshots[0]).toEqual(oldSnapshot); expect(saved.scenarioDigest).toBe(digest(scenario));
      expect(saved.jobs[0].input.learnerCheck).toMatchObject({ workspacePolicyVersion: 1,executionPolicyVersion: 1,sourceSha256: textDigest(source) });
      await expect(store.transaction(db => { (db.sessions[session.id].jobs[0].input.learnerCheck as { sourceSha256: string }).sourceSha256 = 'a'.repeat(64); })).rejects.toMatchObject({ code: 'conflict' });
      const claim = (await restarted.claimJob('check-sql-worker'))!;
      await restarted.completeJob(claim,{ kind: 'run',run: { status: 'completed',command: 'Injected SQL check evidence; no Python executed',stdout: '',stderr: '',exitCode: 0,durationMs: 1,runtimeDigest: fixtureRuntimeId,tests: [{ id: policy.testId,title: 'Learner-authored regression check',status: 'passed' }] } });
      const completed = await service.exportSession(owner,session.id), fact = freezeEvidence(completed,new Date().toISOString()).items.find(item => item.kind === 'test')!;
      expect(completed.runs[0].learnerCheck?.sourceSha256).toBe(textDigest(source)); expect(fact.source).toBe('learner-authored-check');
      expect(JSON.parse(fact.content).learnerCheck.sourceSha256).toBe(textDigest(source));
      await expect(service.getSession(stranger,session.id)).rejects.toMatchObject({ code: 'not_found' });
      const client = await database.admin.connect();
      try {
        await client.query('begin; set local role authenticated');
        await client.query("select set_config('request.jwt.claim.sub',$1,true)",[stranger]);
        expect((await client.query('select files from public.ai_practice_snapshots where session_id=$1',[session.id])).rows).toHaveLength(0);
      } finally { await client.query('rollback'); client.release(); }
      await service.deleteSession(owner,session.id,{ requestId: randomUUID() });
      expect((await database.admin.query('select id from public.ai_practice_snapshots where session_id=$1',[session.id])).rows).toHaveLength(0);
      expect(await restarted.completeJob(claim,{ kind: 'run',run: { status: 'timeout',command: 'stale',stdout: '',stderr: '',exitCode: null,durationMs: 1,tests: [] } })).toBe(false);
    });
  }, 60_000);
});
