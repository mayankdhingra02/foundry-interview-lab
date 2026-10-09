import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import type { CoachOutput, Scenario } from '../lib/interview-practice/types';

// Explicit opt-in: never uses DATABASE_URL or any hosted account. No existing database/container is modified.
const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
const fixture: Scenario = {
  id: 'postgres-fixture', version: '1', title: 'Persistence fixture', summary: 'Synthetic test package', language: 'python', level: 'mid', durationMinutes: 30, tags: ['correctness'], files: { 'service.py': 'def add(a,b): return a-b\n' },
  stages: [{ id: 'debug', title: 'Debug', brief: 'Fix sum', requirements: ['Return sum'] }, { id: 'debrief', title: 'Debrief', brief: 'Explain', requirements: ['Describe tests'] }],
  rubric: [{ id: 'correctness', name: 'Correctness', description: 'Working behavior', anchors: { strong: 'Works', developing: 'Partly works', needsWork: 'Incorrect' } }],
  probes: [{ id: 'probe', stageId: 'debrief', competencyId: 'correctness', question: 'What did you verify?' }], hints: ['Inspect the operator'],
  tests: [{ id: 'sum', title: 'Positive sum', source: 'assert add(1,2)==3', visible: true, timeoutSeconds: 2 }],
  referenceFiles: { 'service.py': 'REFERENCE-PRIVATE' }, drills: [{ id: 'sum-drill', title: 'Try negatives', competencyId: 'correctness', lesson: 'Check examples', exercise: 'Add negative cases' }], rights: 'Original test fixture', runtime: { image: 'python:3.11-slim', memoryMb: 128, timeoutSeconds: 5 },
};
const ownerA = '73efbd73-729b-4b58-80ab-8c67240ef3db';
const ownerB = '51c77415-21f8-4305-b165-c29eb5d3c829';
const req = () => randomUUID();
const mut = (revision: number) => ({ requestId: req(), expectedRevision: revision });
describe.skipIf(!enabled)('normalized PostgreSQL persistence in disposable Docker database', () => {
  let pool: Pool, servicePool: Pool, store: PostgresPracticeStore, service: SessionService;
  let container = '';
  beforeAll(async () => {
    container = `foundry-pg-test-${randomUUID().slice(0, 12)}`;
    execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=disposable_foundry_test_only', '-e', 'POSTGRES_DB=foundry_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' });
    const port = execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1);
    pool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'disposable_foundry_test_only', database: 'foundry_test', max: 8, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let i = 0; i < 80; i++) { try { await pool.query('select 1'); ready = true; break; } catch { await delay(100); } }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready.');
    await pool.query(`create schema auth; create table auth.users (id uuid primary key); create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public,auth to anon,authenticated,service_role; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    for (const file of ['202610090001_ai_practice_foundation.sql', '202610090002_runtime_persistence.sql', '202610090007_event_contract.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    // Runtime qualification uses the actual service-role grants, rather than table-owner privileges.
    servicePool = new Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', password: 'disposable_foundry_test_only', database: 'foundry_test', options: '-c role=service_role', max: 8 });
    expect((await servicePool.query('select current_user')).rows[0].current_user).toBe('service_role');
    store = new PostgresPracticeStore(servicePool); service = new SessionService(store, () => structuredClone(fixture));
  }, 60_000);
  afterAll(async () => {
    await servicePool?.end(); await pool?.end();
    if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' });
  });
  beforeEach(async () => {
    await pool.query('truncate public.ai_practice_sessions cascade; truncate public.ai_practice_requests,public.ai_practice_usage_ledger,public.ai_practice_deletions; delete from auth.users');
    await pool.query('insert into auth.users(id) values ($1),($2)', [ownerA, ownerB]);
  });
  const create = async (owner = ownerA) => (await service.createSession(owner, { scenarioId: fixture.id, requestId: req() })).session;
  it('roundtrips snapshots, events and idempotent cached responses through independent adapters', async () => {
    const key = req(), created = await service.createSession(ownerA, { scenarioId: fixture.id, requestId: key });
    const reloaded = new SessionService(new PostgresPracticeStore(servicePool), () => fixture);
    expect(await reloaded.createSession(ownerA, { scenarioId: fixture.id, requestId: key })).toEqual(created);
    const saved = await reloaded.saveWorkspace(ownerA, created.session.id, { ...mut(created.session.revision), files: { 'service.py': 'def add(a,b): return a+b\n' } });
    expect((await service.getSession(ownerA, saved.session.id)).files).toEqual(saved.session.files);
    const counts = await pool.query('select (select count(*) from ai_practice_sessions)::int as sessions,(select count(*) from ai_practice_snapshots)::int as snapshots,(select count(*) from ai_practice_events)::int as events');
    expect(counts.rows[0]).toEqual({ sessions: 1, snapshots: 2, events: 2 });
    const metadata = await pool.query('select runtime_payload from ai_practice_sessions');
    expect(metadata.rows[0].runtime_payload).not.toHaveProperty('snapshots');
    expect(metadata.rows[0].runtime_payload).not.toHaveProperty('files');
  });
  it('serializes concurrent quota admission and stale-revision writes', async () => {
    const restricted = new SessionService(new PostgresPracticeStore(servicePool), () => fixture, { maxDailySessions: 1 });
    const created = await Promise.allSettled([restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() }), restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() })]);
    expect(created.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const session = (await restricted.listSessions(ownerA))[0];
    const updates = await Promise.allSettled([service.saveWorkspace(ownerA, session.id, { ...mut(session.revision), files: { 'service.py': 'first' } }), service.saveWorkspace(ownerA, session.id, { ...mut(session.revision), files: { 'service.py': 'second' } })]);
    expect(updates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('fails closed on real per-table capacity overflow without truncating acknowledged evidence', async () => {
    const session = await create();
    await service.saveWorkspace(ownerA, session.id, { ...mut(session.revision), files: { 'service.py': 'acknowledged second snapshot' } });
    const restricted = new PostgresPracticeStore(servicePool, { maxEntityRows: 1 });
    await expect(restricted.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect((await service.getSession(ownerA, session.id)).files['service.py']).toBe('acknowledged second snapshot');
    expect((await pool.query('select count(*)::int as count from ai_practice_snapshots')).rows[0].count).toBe(2);
  });
  it('enforces the real SQL payload byte preflight before accepting a bounded-corpus read', async () => {
    const session = await create();
    const restricted = new PostgresPracticeStore(servicePool, { maxStateBytes: 1 });
    await expect(restricted.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect((await service.getSession(ownerA, session.id)).files).toEqual(session.files);
  });
  it('enforces actual SQL RLS, anonymous denial and composite owner relationships', async () => {
    const a = await create(ownerA); await create(ownerB);
    const client = await pool.connect();
    try {
      await client.query('begin; set local role authenticated'); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerA]);
      const result = await client.query('select id,user_id from public.ai_practice_sessions'); expect(result.rows).toEqual([{ id: a.id, user_id: ownerA }]);
      expect((await client.query('select count(*)::int as count from public.ai_practice_snapshots')).rows[0].count).toBe(1);
      await expect(client.query('delete from public.ai_practice_sessions where id=$1', [a.id])).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback; begin; set local role anon');
      await expect(client.query('select * from public.ai_practice_sessions')).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
    } finally { await client.query('rollback'); client.release(); }
    await expect(pool.query('insert into public.ai_practice_turns(id,session_id,user_id,role,sequence,runtime_payload) values ($1,$2,$3,$4,1,$5)', [req(), a.id, ownerB, 'learner', JSON.stringify({ id: req(), text: 'cross-owner' })])).rejects.toMatchObject({ code: '23503' });
    const publicManifest = (await pool.query('select manifest from public.practice_scenario_versions')).rows[0].manifest;
    expect(JSON.stringify(publicManifest)).not.toContain('REFERENCE-PRIVATE');
  });
  it('rolls back callback exceptions and protects acknowledged evidence in SQL', async () => {
    const session = await create();
    await expect(store.transaction(db => { db.sessions[session.id].files['service.py'] = 'uncommitted'; throw new Error('planned rollback'); })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await service.getSession(ownerA, session.id)).files['service.py']).toBe(fixture.files['service.py']);
    await expect(pool.query("update public.ai_practice_events set payload='{}'::jsonb where session_id=$1", [session.id])).rejects.toMatchObject({ code: '23514' });
  });
  it('retains strict event type and schema-version rejection after the additive event migration', async () => {
    const session = await create(), original = session.events[0], at = new Date().toISOString();
    const insert = (type: string, version: number) => pool.query('insert into public.ai_practice_events(id,session_id,user_id,sequence,schema_version,event_type,source,request_id,payload,occurred_at,recorded_at,runtime_payload) values ($1,$2,$3,2,$4,$5,$6,$7,$8,$9,$9,$10)', [req(),session.id,ownerA,version,type,'server',req(),'{}',at,JSON.stringify({ ...original, type, schemaVersion: version, sequence: 2 })]);
    await expect(insert('unknown.event', 1)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('session.paused', 2)).rejects.toMatchObject({ code: '23514' });
    expect((await service.getSession(ownerA, session.id)).events).toHaveLength(1);
  });
  it('persists lease takeover, fencing and uncertain external cost across service restarts', async () => {
    let now = new Date('2026-10-09T12:00:00.000Z');
    const original = new SessionService(new PostgresPracticeStore(servicePool), () => fixture, { now: () => now, leaseMs: 1000 });
    const session = (await original.createSession(ownerA, { scenarioId: fixture.id, requestId: req() })).session;
    await original.requestAssistant(ownerA, session.id, { ...mut(session.revision), mode: 'ask', message: 'Explain the code' });
    const first = await original.claimJob('first-worker'); now = new Date(now.getTime() + 1100);
    const restarted = new SessionService(new PostgresPracticeStore(servicePool), () => fixture, { now: () => now, leaseMs: 1000 }), second = await restarted.claimJob('second-worker');
    expect(await restarted.completeJob(first!, { kind: 'assistant', model: 'test-fixture', message: 'stale', actualUsd: 0 })).toBe(false);
    expect(await restarted.completeJob(second!, { kind: 'assistant', model: 'test-fixture', message: 'Current answer', actualUsd: 0.01 })).toBe(true);
    expect((await restarted.getSession(ownerA, session.id)).usage.uncertainUsd).toBeCloseTo(0.08);
    const job = (await pool.query('select state,fencing_token from public.ai_practice_jobs')).rows[0]; expect(job.state).toBe('completed'); expect(Number(job.fencing_token)).toBe(2);
  });
  it('stores assistant proposals and accepted edits in normalized owner rows', async () => {
    let session = await create();
    await service.requestAssistant(ownerA, session.id, { ...mut(session.revision), mode: 'edit', message: 'Propose a fix' }); const claim = await service.claimJob('worker');
    await service.completeJob(claim!, { kind: 'assistant', model: 'synthetic-fixture', message: 'Inspect this proposed fix.', files: { 'service.py': 'def add(a,b): return a+b\n' }, actualUsd: 0 });
    session = await service.getSession(ownerA, session.id);
    await service.decideEdit(ownerA, session.id, { ...mut(session.revision), proposalId: session.editProposals[0].id, decision: 'accept' });
    const reloaded = await new SessionService(new PostgresPracticeStore(servicePool), () => fixture).getSession(ownerA, session.id);
    expect(reloaded.editProposals[0].status).toBe('accepted'); expect(reloaded.files['service.py']).toContain('a+b');
    expect((await pool.query('select count(*)::int as count from ai_practice_assistant_messages')).rows[0].count).toBe(2);
    expect((await pool.query('select status from ai_practice_edit_proposals')).rows[0].status).toBe('accepted');
  });
  it('keeps immutable coaching generation identity across failed-job retry', async () => {
    let session = await create();
    const finished = await service.command(ownerA, session.id, { ...mut(session.revision), action: 'finish' });
    await service.cancelJob(ownerA, finished.job!.id, { requestId: req() }); session = await service.getSession(ownerA, session.id);
    await service.command(ownerA, session.id, { ...mut(session.revision), action: 'submit' });
    const first = await service.claimJob('worker'); await service.failJob(first!, 'Synthetic provider interruption', 0);
    const retry = await service.retryReport(ownerA, session.id, { requestId: req() }); expect(retry.job!.id).toBe(first!.job.id);
    const claimed = await service.claimJob('worker-2'); expect(claimed!.job.input).toEqual(first!.job.input);
    await service.completeJob(claimed!, { kind: 'coach', actualUsd: 0, model: 'synthetic-fixture', promptVersion: 'fixture-v1', report: { overview: 'No final test observation was recorded.', rubric: [{ criterionId: 'correctness', level: 'Not observed', feedback: 'Run a small example next time.', evidenceIds: [], confidence: 'low' }], nextPractice: [{ drillId: 'sum-drill', reason: 'Try an example.' }] } });
    expect((await service.getSession(ownerA, session.id)).reports[0].generationId).toBe(first!.job.input.generationId);
    await expect(pool.query("update public.ai_practice_reports set model='changed' where session_id=$1", [session.id])).rejects.toMatchObject({ code: '23514' });
  });
  it('retains content-free quota admission when deleting only an attempt', async () => {
    const restricted = new SessionService(new PostgresPracticeStore(servicePool), () => fixture, { maxDailySessions: 1 });
    const session = (await restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() })).session;
    await restricted.deleteSession(ownerA, session.id, { requestId: req() });
    await expect(restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() })).rejects.toMatchObject({ code: 'quota' });
    expect((await pool.query('select count(*)::int as count from ai_practice_snapshots')).rows[0].count).toBe(0);
    expect((await pool.query("select count(*)::int as count from ai_practice_usage_ledger where kind='admission'")).rows[0].count).toBe(1);
  });
  it('persists frozen debrief, deterministic runs and immutable report generations separately', async () => {
    let session = await create();
    await service.requestRun(ownerA, session.id, mut(session.revision)); const run = await service.claimJob('worker');
    await service.completeJob(run!, { kind: 'run', run: { status: 'completed', command: 'synthetic fixture check', stdout: '', stderr: '', exitCode: 0, durationMs: 2, tests: [{ id: 'sum', title: 'Positive sum', status: 'failed' }] } });
    session = await service.getSession(ownerA, session.id);
    await service.command(ownerA, session.id, { ...mut(session.revision), action: 'finish' }); const question = await service.claimJob('worker');
    await service.completeJob(question!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'ask_probe', question: 'What did you check?', competencyId: 'correctness', evidenceIds: [], probeId: 'probe' } });
    session = await service.getSession(ownerA, session.id);
    await service.commitTurn(ownerA, session.id, { ...mut(session.revision), text: 'I found subtraction instead of addition.' }); const end = await service.claimJob('worker');
    await service.completeJob(end!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'end_debrief', evidenceIds: [] } });
    session = await service.getSession(ownerA, session.id); await service.command(ownerA, session.id, { ...mut(session.revision), action: 'submit' });
    const coach = await service.claimJob('worker'), context = await service.exportSession(ownerA, session.id);
    const report: CoachOutput = { overview: 'The recorded check failed; inspect the operation.', rubric: [{ criterionId: 'correctness', level: 'Developing', feedback: 'Compare operator and contract.', evidenceIds: [context.frozenEvidence!.items[0].id], confidence: 'low' }], nextPractice: [{ drillId: 'sum-drill', reason: 'Work through negative examples.' }] };
    await service.completeJob(coach!, { kind: 'coach', report, model: 'synthetic-fixture', promptVersion: 'test-v1', actualUsd: 0 });
    const reloaded = new SessionService(new PostgresPracticeStore(servicePool), () => fixture), persisted = await reloaded.getSession(ownerA, session.id);
    expect(persisted.lifecycle).toBe('completed'); expect(persisted.turns).toHaveLength(2); expect(persisted.runs).toHaveLength(1); expect(persisted.reports).toHaveLength(1);
    expect(persisted.frozenEvidence!.items.some(e => e.content.includes('subtraction'))).toBe(true);
    const counts = (await pool.query('select (select count(*) from ai_practice_turns)::int as turns,(select count(*) from ai_practice_runs)::int as runs,(select count(*) from ai_practice_reports)::int as reports,(select count(*) from ai_practice_evidence_manifests)::int as manifests')).rows[0];
    expect(counts).toEqual({ turns: 2, runs: 1, reports: 1, manifests: 1 });
  });
  it('erases private caches and keeps cleanup records through account cascades', async () => {
    const session = await create(); await service.requestRun(ownerA, session.id, mut(session.revision)); const claim = await service.claimJob('worker');
    await service.deleteAccount(ownerA, { requestId: req() }); await pool.query('delete from auth.users where id=$1', [ownerA]);
    expect(await service.failJob(claim!, 'late result', 0)).toBe(false);
    expect((await pool.query('select count(*)::int as count from public.ai_practice_sessions')).rows[0].count).toBe(0);
    expect((await pool.query('select count(*)::int as count from public.ai_practice_requests')).rows[0].count).toBe(0);
    expect((await pool.query('select count(*)::int as count from public.ai_practice_deletions')).rows[0].count).toBe(1);
  });
});
