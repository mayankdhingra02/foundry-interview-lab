import { completeFixtureJob } from './inference-fixtures';
import { fixtureRuntimeId } from './runtime-fixtures';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import type { CoachOutput, LedgerEntry, Scenario } from '../lib/interview-practice/types';
import { inferenceBindingFromPolicy, parseInferenceBinding } from '../lib/ai/binding';
import { digest } from '../lib/interview-practice/domain';

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
    for (const file of ['202610090001_ai_practice_foundation.sql', '202610090002_runtime_persistence.sql', '202610090007_event_contract.sql', '202610090008_private_job_reads.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
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
  it('measures reduced JSON row transport on the same SQL corpus without changing private evidence', async () => {
    const session = await create();
    await service.saveWorkspace(ownerA,session.id,{ ...mut(session.revision),files: { 'service.py': 'SYNTHETIC-CORPUS-CONTENT'.repeat(100) } });
    const before = await store.read(), measurement = await store.measureLoadTransport();
    expect(await store.read()).toEqual(before);
    expect(measurement.entityRows).toBe(8); // 1 session,2 snapshots,2 events,2 request caches,1 admission.
    expect(measurement.projectedRowJsonBytes).toBeLessThan(measurement.fullRowJsonBytes);
    expect(measurement.projectedRowJsonBytes).toBeGreaterThan(0);
    expect(Object.values(measurement).every(value => Number.isSafeInteger(value) && value >= 0)).toBe(true);
    expect(JSON.stringify(measurement)).not.toContain('SYNTHETIC-CORPUS-CONTENT');
  });
  it('serializes concurrent quota admission and stale-revision writes', async () => {
    const restricted = new SessionService(new PostgresPracticeStore(servicePool), () => fixture, { maxDailySessions: 1 });
    const created = await Promise.allSettled([restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() }), restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() })]);
    expect(created.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const session = (await restricted.listSessions(ownerA))[0];
    const updates = await Promise.allSettled([service.saveWorkspace(ownerA, session.id, { ...mut(session.revision), files: { 'service.py': 'first' } }), service.saveWorkspace(ownerA, session.id, { ...mut(session.revision), files: { 'service.py': 'second' } })]);
    expect(updates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('persists an admitted immutable runtime and rejects repinning or mismatched completion atomically', async () => {
    const session = await create();
    const request = mut(session.revision), admitted = await service.requestRun(ownerA,session.id,request);
    const second = new SessionService(new PostgresPracticeStore(servicePool),() => fixture,{ runtimeBinding: () => ({ version: 1,scenarioImage: fixture.runtime.image,imageAlias: fixture.runtime.image,imageId: `sha256:${'c'.repeat(64)}` }) });
    expect(await second.requestRun(ownerA,session.id,request)).toEqual(admitted);
    const stored = await service.exportSession(ownerA,session.id);
    expect(stored.jobs[0].input.runtimeBinding).toMatchObject({ imageId: fixtureRuntimeId });
    await expect(store.transaction(db => {
      db.sessions[session.id].jobs[0].input.runtimeBinding = { version: 1,scenarioImage: fixture.runtime.image,imageAlias: fixture.runtime.image,imageId: `sha256:${'c'.repeat(64)}` };
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(await service.exportSession(ownerA,session.id)).toEqual(stored);
    const claim = (await second.claimJob('pinned-worker'))!;
    const before = await store.read();
    const run = { status: 'completed' as const,command: 'synthetic SQL fixture',stdout: '',stderr: '',exitCode: 0,tests: [],durationMs: 1 };
    await expect(completeFixtureJob(second, claim,{ kind: 'run',run: { ...run,runtimeDigest: `sha256:${'c'.repeat(64)}` } })).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.read()).toEqual(before);
    await expect(completeFixtureJob(second, claim,{ kind: 'run',run: { ...run,runtimeDigest: fixtureRuntimeId } })).resolves.toBe(true);
    expect((await service.getSession(ownerA,session.id)).runs[0].runtimeDigest).toBe(fixtureRuntimeId);
  });
  it('roundtrips immutable admitted inference and provenance across adapters without adopting new configuration', async () => {
    const session = await create(), request = { ...mut(session.revision), mode: 'ask' as const, message: 'Synthetic bounded assistance.' };
    const admitted = await service.requestAssistant(ownerA, session.id, request), original = await service.exportSession(ownerA, session.id);
    const binding = parseInferenceBinding(original.jobs[0].input.inferenceBinding)!; expect(binding).not.toBeNull(); expect(original.jobs[0].reservedUsd).toBe(binding.reserveUsd);
    const second = new SessionService(new PostgresPracticeStore(servicePool), () => fixture, { inferenceBinding: role => inferenceBindingFromPolicy(role, { model: 'replacement-synthetic-model', inputRate: 10, outputRate: 20, maxOutput: 3200 }) });
    expect(await second.requestAssistant(ownerA, session.id, request)).toEqual(admitted);
    expect((await second.exportSession(ownerA, session.id)).jobs[0].input).toEqual(original.jobs[0].input);
    await expect(store.transaction(db => {
      const job = db.sessions[session.id].jobs[0]; (job.input.inferenceBinding as Record<string, unknown>).model = 'rebound-model'; job.fingerprint = digest(job.input);
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(await service.exportSession(ownerA, session.id)).toEqual(original);
    const claim = (await second.claimJob('inference-roundtrip-worker'))!;
    expect(await completeFixtureJob(second, claim, { kind: 'assistant', model: 'synthetic-fixture', message: 'A synthetic recorded answer.', actualUsd: 0 })).toBe(true);
    const saved = await service.exportSession(ownerA, session.id), record = saved.jobs[0].inference;
    expect(record).toMatchObject({ provider: binding.provider, requestedModel: binding.model, role: binding.role, promptVersion: binding.promptVersion, schemaVersion: binding.schemaVersion, contextVersion: binding.contextVersion, validated: true });
    expect((await service.getSession(ownerA, session.id)).jobs[0]).not.toHaveProperty('input');
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
  it('rolls back a projected row-cap crossing and keeps acknowledged work readable and deletable', async () => {
    const restrictedStore = new PostgresPracticeStore(servicePool, { maxEntityRows: 2 });
    const restricted = new SessionService(restrictedStore, () => fixture);
    const created = (await restricted.createSession(ownerA, { scenarioId: fixture.id, requestId: req() })).session;
    const saved = (await restricted.saveWorkspace(ownerA, created.id, { ...mut(created.revision), files: { 'service.py': 'last acknowledged content' } })).session;
    const rejectedKey = req(), before = await restrictedStore.read();
    await expect(restricted.saveWorkspace(ownerA, created.id, { requestId: rejectedKey, expectedRevision: saved.revision, files: { 'service.py': 'must roll back' } })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await restrictedStore.read()).toEqual(before);
    expect((await pool.query('select (select count(*) from ai_practice_snapshots)::int as snapshots,(select count(*) from ai_practice_events)::int as events,(select count(*) from ai_practice_requests)::int as requests')).rows[0]).toEqual({ snapshots: 2, events: 2, requests: 2 });
    expect((await restricted.getSession(ownerA, created.id)).files['service.py']).toBe('last acknowledged content');
    await restricted.deleteSession(ownerA, created.id, { requestId: req() });
    expect(await restricted.listSessions(ownerA)).toEqual([]);
    expect((await restrictedStore.read()).deletions).toHaveLength(1);
  });
  it('rolls back exact JSONB payload-byte overflow that fits the earlier whole-state JSON guard', async () => {
    const before = await store.read(), now = '2026-10-09T12:00:00.000Z';
    const ledger: LedgerEntry[] = Array.from({ length: 100 }, () => { const id = req(); return { id, ownerId: ownerA, sessionId: req(), operationId: `${id}:admission`, kind: 'admission', amountUsd: 0, createdAt: now }; });
    const maximum = Buffer.byteLength(JSON.stringify({ ...before, ledger }));
    // This is the adapter's exact persisted metric, not a JavaScript estimate.
    const sqlBytes = Number((await pool.query('select sum(octet_length(entry::text))::text as bytes from jsonb_array_elements($1::jsonb) as elements(entry)', [JSON.stringify(ledger)])).rows[0].bytes);
    expect(sqlBytes).toBeGreaterThan(maximum);
    const restricted = new PostgresPracticeStore(servicePool, { maxStateBytes: maximum });
    await expect(restricted.transaction(db => { db.ledger.push(...ledger); })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await restricted.read()).toEqual(before);
    expect((await pool.query('select count(*)::int as count from ai_practice_usage_ledger')).rows[0].count).toBe(0);
    // A later bounded write is still possible; overflow did not strand the store.
    await restricted.transaction(db => { db.ledger.push(ledger[0]); });
    expect((await restricted.read()).ledger).toEqual([ledger[0]]);
  });
  it('denies direct owner/anonymous job and inference reads while trusted jobs and redacted API views work', async () => {
    const session = await create(); await service.requestAssistant(ownerA, session.id, { ...mut(session.revision), mode: 'ask', message: 'PRIVATE-GENERATION-INPUT' });
    const claim = (await service.claimJob('private-fixture-worker'))!;
    const trusted = (await servicePool.query('select claim_token,runtime_payload from public.ai_practice_jobs')).rows[0];
    expect(trusted.claim_token).toBe(claim.claimToken); expect(trusted.runtime_payload.input.prompt).toBe('PRIVATE-GENERATION-INPUT');
    const view = await service.getSession(ownerA, session.id);
    expect(view.jobs[0]).not.toHaveProperty('claimToken'); expect(view.jobs[0]).not.toHaveProperty('input');
    for (const table of ['ai_practice_jobs','ai_practice_ai_calls']) {
      const grants = (await pool.query('select has_table_privilege($1,$2,$3) as table_read,has_any_column_privilege($1,$2,$3) as column_read', ['authenticated',`public.${table}`,'SELECT'])).rows[0];
      expect(grants).toEqual({ table_read: false, column_read: false });
      for (const actor of [ownerA,ownerB]) {
        const client = await pool.connect();
        try {
          await client.query('begin; set local role authenticated'); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [actor]);
          await expect(client.query(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
        } finally { await client.query('rollback'); client.release(); }
      }
      const client = await pool.connect();
      try { await client.query('begin; set local role anon'); await expect(client.query(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' }); }
      finally { await client.query('rollback'); client.release(); }
    }
    expect((await servicePool.query('select count(*)::int as count from public.ai_practice_ai_calls')).rows[0].count).toBe(0);
    expect(await completeFixtureJob(service, claim, { kind: 'assistant', model: 'synthetic-fixture', message: 'A synthetic answer.', actualUsd: 0 })).toBe(true);
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
    expect(await completeFixtureJob(restarted, first!, { kind: 'assistant', model: 'test-fixture', message: 'stale', actualUsd: 0 })).toBe(false);
    expect(await completeFixtureJob(restarted, second!, { kind: 'assistant', model: 'test-fixture', message: 'Current answer', actualUsd: 0.01 })).toBe(true);
    expect((await restarted.getSession(ownerA, session.id)).usage.uncertainUsd).toBeCloseTo(0.08);
    const job = (await pool.query('select state,fencing_token from public.ai_practice_jobs')).rows[0]; expect(job.state).toBe('completed'); expect(Number(job.fencing_token)).toBe(2);
  });
  it('stores assistant proposals and accepted edits in normalized owner rows', async () => {
    let session = await create();
    await service.requestAssistant(ownerA, session.id, { ...mut(session.revision), mode: 'edit', message: 'Propose a fix' }); const claim = await service.claimJob('worker');
    await completeFixtureJob(service, claim!, { kind: 'assistant', model: 'synthetic-fixture', message: 'Inspect this proposed fix.', files: { 'service.py': 'def add(a,b): return a+b\n' }, actualUsd: 0 });
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
    await completeFixtureJob(service, claimed!, { kind: 'coach', actualUsd: 0, model: 'synthetic-fixture', promptVersion: 'fixture-v1', report: { overview: 'No final test observation was recorded.', rubric: [{ criterionId: 'correctness', level: 'Not observed', feedback: 'Run a small example next time.', evidenceIds: [], confidence: 'low' }], nextPractice: [{ drillId: 'sum-drill', reason: 'Try an example.' }] } });
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
    await completeFixtureJob(service, run!, { kind: 'run', run: { runtimeDigest: fixtureRuntimeId, status: 'completed', command: 'synthetic fixture check', stdout: '', stderr: '', exitCode: 0, durationMs: 2, tests: [{ id: 'sum', title: 'Positive sum', status: 'failed' }] } });
    session = await service.getSession(ownerA, session.id);
    await service.command(ownerA, session.id, { ...mut(session.revision), action: 'finish' }); const question = await service.claimJob('worker');
    await completeFixtureJob(service, question!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'ask_probe', question: 'What did you check?', competencyId: 'correctness', evidenceIds: [], probeId: 'probe' } });
    session = await service.getSession(ownerA, session.id);
    await service.commitTurn(ownerA, session.id, { ...mut(session.revision), text: 'I found subtraction instead of addition.' }); const end = await service.claimJob('worker');
    await completeFixtureJob(service, end!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'end_debrief', evidenceIds: [] } });
    session = await service.getSession(ownerA, session.id); await service.command(ownerA, session.id, { ...mut(session.revision), action: 'submit' });
    const coach = await service.claimJob('worker'), context = await service.exportSession(ownerA, session.id);
    const report: CoachOutput = { overview: 'The recorded check failed; inspect the operation.', rubric: [{ criterionId: 'correctness', level: 'Developing', feedback: 'Compare operator and contract.', evidenceIds: [context.frozenEvidence!.items[0].id], confidence: 'low' }], nextPractice: [{ drillId: 'sum-drill', reason: 'Work through negative examples.' }] };
    await completeFixtureJob(service, coach!, { kind: 'coach', report, model: 'synthetic-fixture', promptVersion: 'test-v1', actualUsd: 0 });
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
