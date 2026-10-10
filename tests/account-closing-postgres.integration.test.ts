import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { getScenario } from '../lib/content/scenarios';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { probeReadiness } from '../lib/server/operations';
import { withDisposablePostgres, type DisposableDatabase } from '../scripts/operations/disposable-postgres';

// Auth/schema/owners are synthetic. This explicit CI opt-in never uses DATABASE_URL.
describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== '1')('permanent account fence in disposable PostgreSQL', () => {
  let database: DisposableDatabase, release: (() => void) | undefined, lifetime: Promise<void> | undefined;
  beforeAll(async () => {
    let accept!: (value: DisposableDatabase) => void, reject!: (error: unknown) => void;
    const available = new Promise<DisposableDatabase>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
    lifetime = withDisposablePostgres(async value => { accept(value); await new Promise<void>(resolve => { release = resolve; }); });
    void lifetime.catch(reject); database = await available;
  }, 60_000);
  afterAll(async () => { release?.(); await lifetime; }, 60_000);

  async function attempt() {
    const owner = randomUUID(); await database.admin.query('insert into auth.users(id) values($1)', [owner]);
    const service = new SessionService(new PostgresPracticeStore(database.service), getScenario);
    const input = { scenarioId: 'monetary-validation', requestId: randomUUID() }, session = (await service.createSession(owner, input)).session;
    return { owner, service, input, session };
  }

  it('atomically captures object keys, erases content and preserves fence/inventory after Auth cascade and restart', async () => {
    const { owner, service, input, session } = await attempt();
    await service.saveWorkspace(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# PRIVATE-CLOSING-SQL-CONTENT' } });
    await database.admin.query('insert into public.ai_practice_artifacts(session_id,user_id,kind,storage_key,sha256,byte_count) values($1,$2,$3,$4,$5,10)', [session.id, owner, 'export', `synthetic-private/${owner}`, 'a'.repeat(64)]);
    const closed = await service.closeAccount(owner, { requestId: randomUUID() }); expect(closed.cleanupState).toBe('pending');
    expect((await database.service.query('select inventory,state from public.ai_practice_deletions where id=$1', [closed.cleanupId])).rows[0]).toEqual({ inventory: [`synthetic-private/${owner}`], state: 'pending' });
    expect((await database.service.query('select count(*)::int as count from public.ai_practice_sessions where user_id=$1', [owner])).rows[0].count).toBe(0);
    const fence = (await database.service.query('select runtime_payload from public.ai_practice_account_closings where opaque_owner_id=$1', [owner])).rows[0].runtime_payload;
    expect(JSON.stringify(fence)).not.toMatch(/PRIVATE-CLOSING-SQL-CONTENT|synthetic-private/);
    // External Auth deletion is represented only by the disposable auth table cascade.
    await database.admin.query('delete from auth.users where id=$1', [owner]);
    const restarted = new SessionService(new PostgresPracticeStore(database.service), getScenario);
    expect(await restarted.closeAccount(owner, { requestId: randomUUID() })).toEqual(closed);
    for (const requestId of [input.requestId, randomUUID()]) await expect(restarted.createSession(owner, { ...input, requestId })).rejects.toMatchObject({ code: 'account_closing', status: 409 });
    expect((await database.service.query('select count(*)::int as count from public.ai_practice_account_closings where opaque_owner_id=$1', [owner])).rows[0].count).toBe(1);
    expect((await database.service.query('select count(*)::int as count from public.ai_practice_deletions where id=$1', [closed.cleanupId])).rows[0].count).toBe(1);
    const references = (await database.admin.query("select confrelid::regclass::text as target from pg_constraint where conrelid='public.ai_practice_account_closings'::regclass and contype='f'")).rows;
    expect(references).toEqual([{ target: 'ai_practice_deletions' }]);
  }, 60_000);

  it('holds the same advisory lock through close, preventing a fresh admission or queued worker claim from reopening', async () => {
    const { owner, service, session } = await attempt();
    await service.requestRun(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision });
    let entered = false, continueClose!: () => void;
    const closeGate = new Promise<void>(resolve => { continueClose = resolve; });
    class PausedCloseStore extends PostgresPracticeStore {
      override async captureOwnerObjectKeys(ownerId: string) { const keys = await super.captureOwnerObjectKeys(ownerId); entered = true; await closeGate; return keys; }
    }
    const createName = `closing-create-${randomUUID()}`, claimName = `closing-claim-${randomUUID()}`, artifactName = `closing-artifact-${randomUUID()}`;
    const createPool = new Pool({ ...database.service.options, max: 1, application_name: createName });
    const claimPool = new Pool({ ...database.service.options, max: 1, application_name: claimName });
    const artifactPool = new Pool({ ...database.service.options, max: 1, application_name: artifactName });
    const closingService = new SessionService(new PausedCloseStore(database.service), getScenario);
    const creating = new SessionService(new PostgresPracticeStore(createPool, { lockTimeoutMs: 15_000, statementTimeoutMs: 30_000 }), getScenario);
    const worker = new SessionService(new PostgresPracticeStore(claimPool, { lockTimeoutMs: 15_000, statementTimeoutMs: 30_000 }), getScenario);
    const closing = closingService.closeAccount(owner, { requestId: randomUUID() });
    void closing.catch(() => undefined);
    const outstanding: Promise<unknown>[] = [closing];
    try {
      await vi.waitFor(() => { expect(entered).toBe(true); }, { timeout: 5_000 });
      const creation = creating.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() });
      const denied = expect(creation).rejects.toMatchObject({ code: 'account_closing' });
      const claim = worker.claimJob('synthetic-race-worker');
      const artifact = artifactPool.query('insert into public.ai_practice_artifacts(session_id,user_id,kind,storage_key,sha256,byte_count) values($1,$2,$3,$4,$5,10)', [session.id, owner, 'export', `synthetic-late/${owner}`, 'b'.repeat(64)]);
      const deniedArtifact = expect(artifact).rejects.toMatchObject({ code: '23514' });
      outstanding.push(creation, denied, claim, artifact, deniedArtifact);
      await vi.waitFor(async () => {
        const waiting = (await database.admin.query("select count(*)::int as count from pg_stat_activity where application_name=any($1::text[]) and wait_event_type='Lock' and wait_event='advisory'", [[createName, claimName, artifactName]])).rows[0].count;
        expect(waiting).toBe(3);
      }, { timeout: 5_000 });
      continueClose();
      await closing; await denied; await deniedArtifact; expect(await claim).toBeNull();
      expect((await database.service.query("select count(*)::int as count from public.ai_practice_usage_ledger where user_id=$1 and kind='admission'", [owner])).rows[0].count).toBe(1);
      expect((await database.service.query('select count(*)::int as count from public.ai_practice_jobs where user_id=$1', [owner])).rows[0].count).toBe(0);
    } finally { continueClose(); await Promise.allSettled(outstanding); await createPool.end(); await claimPool.end(); await artifactPool.end(); }
  }, 60_000);

  it('rejects stale completions and SQL reopening, and enforces private immutable fence privileges/readiness', async () => {
    const { owner, service, session } = await attempt();
    await service.requestRun(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision });
    const claim = await service.claimJob('synthetic-before-close'); expect(claim).not.toBeNull();
    const prior = (await database.admin.query('select * from public.ai_practice_sessions where id=$1', [session.id])).rows[0];
    const priorSnapshot = (await database.admin.query('select * from public.ai_practice_snapshots where session_id=$1 order by sequence limit 1', [session.id])).rows[0];
    const closed = await service.closeAccount(owner, { requestId: randomUUID() });
    expect(await service.heartbeatJob(claim!)).toBe(false); expect(await service.failJob(claim!, 'late synthetic failure')).toBe(false);
    expect(await service.completeJob(claim!, { kind: 'run', run: { status: 'infrastructure_error', command: 'not executed', stdout: '', stderr: '', exitCode: null, tests: [], durationMs: 0 } })).toBe(false);
    await expect(database.service.query('insert into public.ai_practice_sessions select * from jsonb_populate_record(null::public.ai_practice_sessions,$1::jsonb)', [JSON.stringify(prior)])).rejects.toMatchObject({ code: '23514' });
    await expect(database.service.query('insert into public.ai_practice_snapshots select * from jsonb_populate_record(null::public.ai_practice_snapshots,$1::jsonb)', [JSON.stringify(priorSnapshot)])).rejects.toMatchObject({ code: '23514' });
    await expect(database.service.query('insert into public.ai_practice_artifacts(session_id,user_id,kind,storage_key,sha256,byte_count) values($1,$2,$3,$4,$5,10)', [session.id, owner, 'export', 'synthetic-after-close', 'b'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
    await expect(database.service.query("update public.ai_practice_account_closings set request_id='changed-key' where opaque_owner_id=$1", [owner])).rejects.toMatchObject({ code: '23514' });
    await expect(database.service.query('delete from public.ai_practice_account_closings where opaque_owner_id=$1', [owner])).rejects.toMatchObject({ code: '42501' });
    await expect(database.admin.query('delete from public.ai_practice_account_closings where opaque_owner_id=$1', [owner])).rejects.toMatchObject({ code: '23514' });
    await expect(database.admin.query('delete from public.ai_practice_deletions where id=$1', [closed.cleanupId])).rejects.toMatchObject({ code: '23503' });
    for (const role of ['anon', 'authenticated']) {
      const client = await database.admin.connect();
      try { await client.query('begin'); await client.query(`set local role ${role}`); await expect(client.query('select * from public.ai_practice_account_closings')).rejects.toMatchObject({ code: '42501' }); }
      finally { await client.query('rollback'); client.release(); }
    }
    expect((await probeReadiness(database.service, { executionRequired: false, requiredFeatures: { accountClosing: true } })).checks.schema).toBe('ok');
    const client = await database.admin.connect();
    try {
      await client.query('begin'); await client.query('alter table public.ai_practice_jobs disable trigger ai_practice_job_account_open'); await client.query('set local role service_role');
      expect((await probeReadiness(client, { executionRequired: false, requiredFeatures: { accountClosing: true } })).checks.schema).toBe('missing');
    } finally { await client.query('rollback'); client.release(); }
  }, 60_000);

  it('rolls back closing and erasure before transferring an oversized object inventory', async () => {
    const { owner, service, session } = await attempt();
    await database.admin.query('insert into public.ai_practice_artifacts(session_id,user_id,kind,storage_key,sha256,byte_count) values($1,$2,$3,$4,$5,10)', [session.id, owner, 'export', 'x'.repeat(2049), 'a'.repeat(64)]);
    await expect(service.closeAccount(owner, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await service.getSession(owner, session.id)).id).toBe(session.id);
    expect((await database.service.query('select count(*)::int as count from public.ai_practice_account_closings where opaque_owner_id=$1', [owner])).rows[0].count).toBe(0);
    expect((await database.service.query('select count(*)::int as count from public.ai_practice_deletions where opaque_owner_id=$1', [owner])).rows[0].count).toBe(0);
  }, 60_000);
});
