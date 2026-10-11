import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeReadiness, recordWorkerHeartbeat } from '../lib/server/operations';
import type { ReadinessFeatures } from '../lib/server/readiness-schema';
import { withDisposablePostgres, type DisposableDatabase } from '../scripts/operations/disposable-postgres';

// Only this explicit flag creates a fresh local disposable database. No hosted
// DATABASE_URL, provider, existing container, or shared Docker mutation is used.
const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
describe.skipIf(!enabled)('readiness against real PostgreSQL schema and effective grants', () => {
  let database: DisposableDatabase, release: (() => void) | undefined, lifetime: Promise<void> | undefined;
  beforeAll(async () => {
    let accept!: (value: DisposableDatabase) => void, reject!: (error: unknown) => void;
    const available = new Promise<DisposableDatabase>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
    lifetime = withDisposablePostgres(async value => {
      accept(value); await new Promise<void>(resolve => { release = resolve; });
    });
    void lifetime.catch(reject);
    database = await available;
    await recordWorkerHeartbeat(database.service, 'readiness-qualification', true);
  }, 60_000);
  afterAll(async () => { release?.(); await lifetime; }, 60_000);

  async function rejectAlteration(sql: string, requiredFeatures: ReadinessFeatures = {}) {
    const client = await database.admin.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      // Inspect the uncommitted altered catalogs as the actual application role.
      // Rollback restores the disposable schema for the following case.
      await client.query('set local role service_role');
      const result = await probeReadiness(client, { requiredFeatures });
      expect(result.checks.schema).toBe('missing');
      expect(result.status).toBe('not_ready');
      expect(result.checks.worker).toBe('not_checked');
      expect(JSON.stringify(result)).not.toMatch(/ai_practice|runtime_payload|authenticated|grant|column/);
    } finally { await client.query('rollback'); client.release(); }
    expect((await probeReadiness(database.service)).status).toBe('ready');
  }

  it('accepts the full ordered migrations with actual service-role permissions', async () => {
    expect((await database.service.query('select current_user')).rows[0].current_user).toBe('service_role');
    expect((await probeReadiness(database.service, { requiredFeatures: { reviews: true, billing: true, voice: true } })).status).toBe('ready');
  });
  it('rejects foundation tables without the runtime payload column', async () => {
    await rejectAlteration('alter table public.ai_practice_sessions drop column runtime_payload');
  });
  it('rejects a missing normalized child despite the old five tables remaining present', async () => {
    await rejectAlteration('drop table public.ai_practice_assistant_messages');
  });
  it.each([
    'grant select on public.ai_practice_jobs to authenticated',
    'grant select(id) on public.ai_practice_jobs to authenticated',
    'grant select on public.ai_practice_ai_calls to anon',
    'grant update(runtime_payload) on public.ai_practice_usage_ledger to authenticated',
    'grant select(id) on public.ai_practice_usage_ledger to authenticated',
    'grant select on public.ai_practice_usage_ledger to anon',
  ])('rejects unsafe effective client privilege: %s', async sql => { await rejectAlteration(sql); });
  it('rejects disabled RLS and missing trusted server read access', async () => {
    await rejectAlteration('alter table public.ai_practice_sessions disable row level security');
    await rejectAlteration('revoke select on public.ai_practice_jobs from service_role');
    await rejectAlteration('alter role service_role nobypassrls');
  });
  it('rejects disabled immutable evidence enforcement', async () => {
    await rejectAlteration('alter table public.ai_practice_reports disable trigger ai_practice_report_immutable');
  });
  it('rejects the legacy event vocabulary instead of reporting ready before a new writer fails', async () => {
    await rejectAlteration("alter table public.ai_practice_events drop constraint ai_practice_events_event_type_check; alter table public.ai_practice_events add constraint ai_practice_events_event_type_check check(event_type in ('session.started','workspace.saved'))");
  });
  it('requires configured voice constraints and complete support schemas', async () => {
    await rejectAlteration('alter table public.ai_practice_usage_ledger drop constraint ai_practice_voice_metadata', { voice: true });
    await rejectAlteration('drop table public.ai_practice_correction_publications', { reviews: true });
  });
  it('requires durable accounting before reporting the closing capability ready', async () => {
    await rejectAlteration('alter table public.ai_practice_usage_ledger drop constraint ai_practice_usage_content_free');
    await rejectAlteration('alter table public.ai_practice_usage_ledger disable trigger ai_practice_usage_immutable');
    await rejectAlteration('alter table public.ai_practice_usage_ledger add constraint synthetic_auth_fk foreign key(user_id) references auth.users(id) on delete cascade not valid');
  });
});
