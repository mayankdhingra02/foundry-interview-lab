import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inferenceBindingFromPolicy } from '../lib/ai/binding';
import { getScenario } from '../lib/content/scenarios';
import { budgetTotals } from '../lib/interview-practice/quota';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { probeReadiness } from '../lib/server/operations';
import { runRetention } from '../lib/server/retention';
import { reconcileVoiceReservations, reserveVoice, settleVoice } from '../lib/voice/ledger';
import type { VoiceConfig } from '../lib/voice/config';
import { withDisposablePostgres, type DisposableDatabase } from '../scripts/operations/disposable-postgres';
import { voiceDebriefFixture } from './voice-fixtures';
import { runPrivateFileCleanup } from '../lib/server/private-file-cleanup';
import type { PrivateObjectStore } from '../lib/server/private-object-store';

// Explicit opt-in only: fresh owned database, synthetic prices and no providers.
describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== '1')('durable usage after Auth cascade in disposable PostgreSQL', () => {
  let database: DisposableDatabase, release: (() => void) | undefined, lifetime: Promise<void> | undefined;
  beforeAll(async () => {
    let accept!: (value: DisposableDatabase) => void, reject!: (error: unknown) => void;
    const available = new Promise<DisposableDatabase>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
    lifetime = withDisposablePostgres(async value => { accept(value); await new Promise<void>(resolve => { release = resolve; }); });
    void lifetime.catch(reject); database = await available;
  }, 60_000);
  afterAll(async () => { release?.(); await lifetime; }, 60_000);
  function service(at: string, globalUsd = .1) {
    return new SessionService(new PostgresPracticeStore(database.service), getScenario, { now: () => new Date(at), maxDailySessions: 20, maxActiveSessions: 10, maxSessionUsd: 10, maxDailyUsd: 10, maxMonthlyUsd: 100, maxGlobalDailyUsd: globalUsd,
      inferenceBinding: role => inferenceBindingFromPolicy(role, { model: 'synthetic-never-called', inputRate: 1, outputRate: 10 / 3, maxOutput: 2400 }) });
  }
  const owner = async () => { const id = randomUUID(); await database.admin.query('insert into auth.users(id) values($1)', [id]); return id; };
  const create = async (practice: SessionService, ownerId: string, voice = false) => (await practice.createSession(ownerId, { scenarioId: 'monetary-validation', voice, requestId: randomUUID() })).session;

  it('keeps original running holds after Auth cascade/restart and denies another owner against the same global cap', async () => {
    const at = '2026-10-11T12:00:00.321Z', practice = service(at), deletedOwner = await owner(), other = await owner();
    const session = await create(practice, deletedOwner);
    await practice.requestAssistant(deletedOwner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, mode: 'ask', message: 'PRIVATE-SYNTHETIC-QUESTION' });
    const claim = (await practice.claimJob('synthetic-no-provider-worker'))!, before = (await practice.store.read()).ledger;
    const closed = await practice.closeAccount(deletedOwner, { requestId: randomUUID() });
    const committed = (await practice.store.read()).ledger.filter(row => row.ownerId === deletedOwner);
    await database.admin.query('delete from auth.users where id=$1', [deletedOwner]);
    const restarted = service(at), reloaded = await restarted.store.read();
    expect(reloaded.ledger.filter(row => row.ownerId === deletedOwner)).toEqual(committed);
    expect(reloaded.ledger.filter(row => row.ownerId === deletedOwner).slice(0, before.filter(row => row.ownerId === deletedOwner).length)).toEqual(before.filter(row => row.ownerId === deletedOwner));
    expect(budgetTotals(reloaded.ledger.filter(row => row.ownerId === deletedOwner), other, at)).toEqual({ userDailyUsd: 0, userMonthlyUsd: 0, globalDailyUsd: .08 });
    expect(await restarted.closeAccount(deletedOwner, { requestId: randomUUID() })).toEqual(closed);
    const next = await create(restarted, other);
    await expect(restarted.requestAssistant(other, next.id, { requestId: randomUUID(), expectedRevision: next.revision, mode: 'ask', message: 'Synthetic quota probe.' })).rejects.toMatchObject({ code: 'quota' });
    expect(await restarted.failJob(claim, 'Synthetic late result', 0)).toBe(false);
    expect(JSON.stringify(reloaded)).not.toContain('PRIVATE-SYNTHETIC-QUESTION');
    const fks = await database.admin.query("select count(*)::int as count from pg_constraint where conrelid='public.ai_practice_usage_ledger'::regclass and contype='f'"); expect(fks.rows[0].count).toBe(0);
  }, 60_000);

  it('preserves voice dollars/minutes and permits one conservative late reconciliation after Auth deletion', async () => {
    const at = '2026-10-12T12:00:00.000Z', later = new Date('2026-10-12T12:03:00.000Z'), practice = service(at, 10), deletedOwner = await owner(), other = await owner();
    const session = await create(practice, deletedOwner, true); await voiceDebriefFixture(practice.store, session.id);
    const config: VoiceConfig = { apiKey: 'synthetic-not-a-key', sttUsdPerMinute: .0043, ttsUsdPerThousandChars: .03, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 1 / 60, sessionUsd: 10, userDailyUsd: 10, userMonthlyUsd: 100, globalDailyUsd: 10 };
    const input = { ownerId: deletedOwner, sessionId: session.id, requestId: randomUUID(), operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 1, characters: 0, usd: .04 };
    const reservation = await reserveVoice(practice.store, config, input, new Date(at));
    await practice.closeAccount(deletedOwner, { requestId: randomUUID() }); await database.admin.query('delete from auth.users where id=$1', [deletedOwner]);
    const restarted = new PostgresPracticeStore(database.service);
    const next = await create(service(at, 10), other, true); await voiceDebriefFixture(restarted, next.id);
    await expect(reserveVoice(restarted, config, { ...input, ownerId: other, sessionId: next.id, requestId: randomUUID() }, new Date(at))).rejects.toMatchObject({ code: 'quota' });
    expect(await settleVoice(restarted, reservation, false, later)).toBe(false);
    expect(await settleVoice(restarted, reservation, false, later)).toBe(false);
    expect((await reconcileVoiceReservations(restarted, { apply: true, now: later })).reconciled).toBe(0);
    const rows = (await restarted.read()).ledger.filter(row => row.operationId.startsWith(reservation.key));
    expect(rows.map(row => row.kind).sort()).toEqual(['reservation', 'uncertain']); expect(rows.every(row => row.budgetAt === at)).toBe(true);
    expect(budgetTotals(rows, other, at).globalDailyUsd).toBe(.04);
    const retained = await runRetention(restarted, { apply: true, now: new Date('2027-10-12T12:00:00Z') });
    expect(retained.retained.unsettled_or_uncertain).toBeGreaterThan(0); expect((await restarted.read()).ledger.filter(row => row.operationId.startsWith(reservation.key))).toEqual(rows);
  }, 60_000);

  it('enforces immutable content-free server-only postings and fails closing before a legacy FK can erase them', async () => {
    const at = '2026-10-13T12:00:00.000Z', practice = service(at), id = await owner(), session = await create(practice, id);
    const row = (await database.admin.query('select * from public.ai_practice_usage_ledger where user_id=$1', [id])).rows[0];
    await expect(database.service.query('update public.ai_practice_usage_ledger set amount_usd=1 where id=$1', [row.id])).rejects.toMatchObject({ code: '23514' });
    const bad = { ...row, id: randomUUID(), operation_id: `${randomUUID()}:admission`, runtime_payload: { ...row.runtime_payload, privateSource: 'PRIVATE-SOURCE' } };
    bad.runtime_payload.id = bad.id; bad.runtime_payload.operationId = bad.operation_id;
    await expect(database.service.query('insert into public.ai_practice_usage_ledger select * from jsonb_populate_record(null::public.ai_practice_usage_ledger,$1::jsonb)', [JSON.stringify(bad)])).rejects.toMatchObject({ code: '23514' });
    for (const role of ['anon', 'authenticated']) {
      const client = await database.admin.connect();
      try { await client.query('begin'); await client.query(`set local role ${role}`); await expect(client.query('select id from public.ai_practice_usage_ledger')).rejects.toMatchObject({ code: '42501' }); }
      finally { await client.query('rollback'); client.release(); }
    }
    // A NOT VALID old FK can coexist with deleted opaque owners; its presence
    // still makes the current closing capability fail before any erasure.
    await database.admin.query('alter table public.ai_practice_usage_ledger add constraint synthetic_legacy_auth_fk foreign key(user_id) references auth.users(id) on delete cascade not valid');
    try {
      await expect(practice.closeAccount(id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
      expect((await practice.getSession(id, session.id)).id).toBe(session.id);
      expect((await probeReadiness(database.service, { executionRequired: false })).checks.schema).toBe('missing');
    } finally { await database.admin.query('alter table public.ai_practice_usage_ledger drop constraint synthetic_legacy_auth_fk'); }
  }, 60_000);

  it('rejects mismatched deletion session/creation columns before any Storage operation', async () => {
    const at = '2026-10-14T12:00:00.321Z', practice = service(at), id = await owner();
    await practice.closeAccount(id, { requestId: randomUUID() });
    const sessionId = randomUUID(), deletion = { id: randomUUID(), ownerId: id, sessionId, state: 'pending' as const, createdAt: at, objectKeys: [`owners/${id}/sessions/${sessionId}/artifacts/${randomUUID()}`] };
    await practice.store.transaction(state => { state.deletions.push(deletion); });
    const objects: PrivateObjectStore = { targetDigest: 'a'.repeat(64), verifyPrivateBucket: vi.fn(async () => true), remove: vi.fn(async () => undefined), absence: vi.fn(async () => 'absent' as const) };
    for (const payload of [{ ...deletion, sessionId: randomUUID() }, { ...deletion, createdAt: '2026-10-14T12:00:00.322Z' }]) {
      await database.admin.query('update public.ai_practice_deletions set runtime_payload=$2::jsonb where id=$1', [deletion.id, JSON.stringify(payload)]);
      try {
        await expect(runPrivateFileCleanup(practice.store, objects, { apply: true })).rejects.toMatchObject({ code: 'unavailable' });
        expect(objects.verifyPrivateBucket).not.toHaveBeenCalled(); expect(objects.remove).not.toHaveBeenCalled(); expect(objects.absence).not.toHaveBeenCalled();
      } finally { await database.admin.query('update public.ai_practice_deletions set runtime_payload=$2::jsonb where id=$1', [deletion.id, JSON.stringify(deletion)]); }
    }
    await database.admin.query('delete from public.ai_practice_deletions where id=$1', [deletion.id]);
  }, 60_000);

  it('blocks private cleanup before Storage when a closing guard or RESTRICT inventory FK is missing', async () => {
    const at = '2026-10-15T12:00:00.000Z', practice = service(at), id = await owner();
    await practice.closeAccount(id, { requestId: randomUUID() });
    const sessionId = randomUUID(), deletion = { id: randomUUID(), ownerId: id, sessionId, state: 'pending' as const, createdAt: at, objectKeys: [`owners/${id}/sessions/${sessionId}/artifacts/${randomUUID()}`] };
    await practice.store.transaction(state => { state.deletions.push(deletion); });
    const objects: PrivateObjectStore = { targetDigest: 'a'.repeat(64), verifyPrivateBucket: vi.fn(async () => true), remove: vi.fn(async () => undefined), absence: vi.fn(async () => 'absent' as const) };
    await practice.store.transaction(() => practice.store.assertPrivateCleanupReady!());
    for (const [alter, restore] of [
      ['alter table public.ai_practice_account_closings disable trigger ai_practice_account_closing_guard', 'alter table public.ai_practice_account_closings enable trigger ai_practice_account_closing_guard'],
      ['alter table public.ai_practice_account_closings drop constraint ai_practice_account_closings_cleanup_id_fkey', 'alter table public.ai_practice_account_closings add constraint ai_practice_account_closings_cleanup_id_fkey foreign key(cleanup_id) references public.ai_practice_deletions(id) on delete restrict'],
    ]) {
      await database.admin.query(alter);
      try {
        await expect(runPrivateFileCleanup(practice.store, objects, { apply: true })).rejects.toMatchObject({ code: 'unavailable' });
        expect(objects.verifyPrivateBucket).not.toHaveBeenCalled(); expect(objects.remove).not.toHaveBeenCalled(); expect(objects.absence).not.toHaveBeenCalled();
        expect((await practice.store.read()).deletions.find(record => record.id === deletion.id)).toEqual(deletion);
      } finally { await database.admin.query(restore); }
    }
    await database.admin.query('delete from public.ai_practice_deletions where id=$1', [deletion.id]);
  }, 60_000);
});
