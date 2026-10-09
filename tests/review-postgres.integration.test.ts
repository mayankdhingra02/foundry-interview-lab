import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { author, correction, finalAttempt, harness, openCase, other, owner, requestId, reviewer, scenario } from './review-fixtures';

// Authoring this opt-in suite does not qualify SQL. It never reads DATABASE_URL or a hosted account.
// Do not enable it while the current task's no-Docker instruction remains in force.
const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
describe.skipIf(!enabled)('review workflow in a disposable real PostgreSQL database', () => {
  let container = '', pool: Pool, servicePool: Pool, store: PostgresPracticeStore, context: ReturnType<typeof harness>;
  beforeAll(async () => {
    container = `foundry-review-test-${randomUUID().slice(0, 12)}`;
    execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=disposable_foundry_test_only', '-e', 'POSTGRES_DB=foundry_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' });
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'disposable_foundry_test_only', database: 'foundry_test' };
    pool = new Pool({ ...connection, max: 8, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let i = 0; i < 80; i++) { try { await pool.query('select 1'); ready = true; break; } catch { await delay(100); } }
    if (!ready) throw new Error('Disposable review PostgreSQL did not become ready.');
    await pool.query(`create schema auth; create table auth.users(id uuid primary key); create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public,auth to anon,authenticated,service_role; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant execute on function auth.uid() to anon,authenticated,service_role;`);
    for (const file of ['202610090001_ai_practice_foundation.sql','202610090002_runtime_persistence.sql','202610090006_reviews.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    servicePool = new Pool({ ...connection, max: 8, options: '-c role=service_role' });
    expect((await servicePool.query('select current_user')).rows[0].current_user).toBe('service_role');
    store = new PostgresPracticeStore(servicePool); context = harness(store);
  }, 60_000);
  afterAll(async () => { await servicePool?.end(); await pool?.end(); if (container) execFileSync('docker', ['rm','-f',container], { stdio: 'pipe' }); });
  beforeEach(async () => {
    await pool.query('truncate public.ai_practice_sessions cascade; truncate public.ai_practice_requests,public.ai_practice_usage_ledger,public.ai_practice_deletions,public.ai_practice_review_audits; delete from auth.users');
    await pool.query('insert into auth.users(id) values ($1),($2),($3),($4)', [owner,other,author.id,reviewer.id]);
  });
  const draft = async () => {
    const session = await finalAttempt(context), item = await openCase(context, session.id);
    const proposal = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Clarify recorded behavior.', report: await correction(context, session.id) });
    return { session, item, proposal };
  };
  it('roundtrips normalized private drafts and separate metadata through independent adapters', async () => {
    const { session, item, proposal } = await draft();
    const restarted = harness(new PostgresPracticeStore(servicePool));
    expect((await restarted.reviews.inspect(reviewer, item.id, { requestId: requestId(), purpose: 'Review the disputed evidence.' })).drafts[0].id).toBe(proposal.id);
    expect((await restarted.reviews.exportOwner(owner, session.id)).drafts).toHaveLength(1);
    const rows = (await pool.query('select (select count(*) from ai_practice_review_cases)::int as cases,(select count(*) from ai_practice_correction_drafts)::int as drafts,(select count(*) from ai_practice_reports)::int as reports')).rows[0];
    expect(rows).toEqual({ cases: 1, drafts: 1, reports: 1 });
    expect(JSON.stringify((await pool.query('select runtime_payload from ai_practice_sessions')).rows)).not.toContain('PRIVATE-UNPUBLISHED-CORRECTION');
  });
  it('enforces actual owner RLS and denies direct authenticated draft/audit access and all client writes', async () => {
    const { item } = await draft(); const second = (await context.practice.createSession(other, { scenarioId: scenario.id, requestId: requestId() })).session;
    await context.reviews.createCase(other, second.id, { requestId: requestId(), category: 'technical', message: 'Other owner request.', inspectionConsent: false, supportActionsConsent: false });
    const client = await pool.connect();
    try {
      await client.query('begin; set local role authenticated'); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
      expect((await client.query('select id from public.ai_practice_review_cases')).rows).toEqual([{ id: item.id }]);
      await expect(client.query('select * from public.ai_practice_correction_drafts')).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback; begin; set local role authenticated');
      await expect(client.query('select * from public.ai_practice_review_audits')).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback; begin; set local role authenticated');
      await expect(client.query("update public.ai_practice_review_cases set inspection_consent=true")).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback; begin; set local role anon');
      await expect(client.query('select * from public.ai_practice_review_cases')).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('rollback'); client.release(); }
  });
  it('protects immutable draft rows and rejects a cross-owner case relationship in SQL', async () => {
    const { proposal } = await draft();
    await expect(pool.query("update public.ai_practice_correction_drafts set runtime_payload=jsonb_set(runtime_payload,'{reason}','\"changed\"') where id=$1", [proposal.id])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('insert into public.ai_practice_correction_decisions(id,session_id,user_id,case_id,draft_id,reviewer_id,decision,created_at,runtime_payload) values ($1,$2,$3,$4,$5,$6,$7,now(),$8)', [requestId(),proposal.sessionId,other,proposal.caseId,proposal.id,reviewer.id,'approve','{}'])).rejects.toMatchObject({ code: '23503' });
  });
  it('publishes one immutable generation and prevents stale concurrent drafts from both succeeding', async () => {
    const { session, item, proposal } = await draft();
    const second = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Alternative correction.', report: await correction(context, session.id) });
    for (const candidate of [proposal,second]) await context.reviews.reviewDraft(reviewer, candidate.id, { requestId: requestId(), decision: 'approve', note: 'Checked each citation and wording.' });
    const independent = harness(new PostgresPracticeStore(servicePool));
    const results = await Promise.allSettled([context.reviews.publishDraft(author, proposal.id, { requestId: requestId() }), independent.reviews.publishDraft(reviewer, second.id, { requestId: requestId() })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const updated = await independent.practice.getSession(owner, session.id); expect(updated.reports).toHaveLength(2); expect(updated.reports[0]).toEqual(session.reports[0]); expect(updated.frozenEvidence).toEqual(session.frozenEvidence);
    expect((await pool.query('select count(*)::int as count from ai_practice_correction_publications')).rows[0].count).toBe(1);
  });
  it('rolls back rejected correction validation without leaving draft/audit/idempotency copies', async () => {
    const session = await finalAttempt(context), item = await openCase(context, session.id), report = await correction(context, session.id);
    const before = await store.read();
    await expect(context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Invalid assertion.', report: { ...report, overview: 'All tests passed.' } })).rejects.toMatchObject({ code: 'invalid' });
    const after = await store.read(); expect(after.reviews).toEqual(before.reviews); expect(after.requests).toEqual(before.requests);
  });
  it('revalidates revoked consent after restart and deletes every learner-linked review copy', async () => {
    const { session, item } = await draft(), current = (await context.reviews.listOwnerCases(owner))[0];
    await context.reviews.setConsent(owner, item.id, { requestId: requestId(), expectedRevision: current.revision, inspectionConsent: false, supportActionsConsent: false });
    const restarted = harness(new PostgresPracticeStore(servicePool));
    await expect(restarted.reviews.inspect(author, item.id, { requestId: requestId(), purpose: 'Denied inspection.' })).rejects.toMatchObject({ status: 403 });
    await restarted.practice.deleteSession(owner, session.id, { requestId: requestId() });
    for (const table of ['ai_practice_review_cases','ai_practice_correction_drafts','ai_practice_correction_decisions','ai_practice_correction_publications','ai_practice_review_audits']) expect((await pool.query(`select count(*)::int as count from public.${table} where session_id=$1`, [session.id])).rows[0].count).toBe(0);
    expect(JSON.stringify(await restarted.reviews.exportOwner(owner))).not.toContain('PRIVATE-');
    expect((await pool.query('select count(*)::int as count from ai_practice_requests where session_id=$1', [session.id])).rows[0].count).toBe(0);
  });
  it('preserves frozen coach input and worker fencing across support recovery and restart', async () => {
    const session = await finalAttempt(context, true), item = await openCase(context, session.id, false, true), original = (await context.practice.exportSession(owner, session.id)).jobs.find(job => job.kind === 'coach')!;
    await context.reviews.recover(author, item.id, { requestId: requestId(), action: 'retry-report' });
    const restarted = harness(new PostgresPracticeStore(servicePool)), claim = await restarted.practice.claimJob('restarted-worker');
    expect(claim!.job.input).toEqual(original.input);
    await restarted.reviews.recover(author, item.id, { requestId: requestId(), action: 'cancel-job', jobId: original.id });
    expect(await restarted.practice.failJob(claim!, 'Late cancelled result.', 0)).toBe(false);
    expect((await restarted.practice.getJob(owner, original.id)).state).toBe('cancelled');
  });
});
