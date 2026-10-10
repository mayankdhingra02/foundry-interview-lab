import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { getScenario } from '../lib/content/scenarios';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { reconcileVoiceReservations, reserveVoice, settleVoice, VOICE_RECONCILIATION_POLICY, type VoiceLedgerEntry } from '../lib/voice/ledger';
import { budgetTotals } from '../lib/interview-practice/quota';
import type { VoiceConfig } from '../lib/voice/config';

// Opt-in creates and removes only a fresh local Docker database. It never reads
// DATABASE_URL, uses a hosted account, or calls a speech provider.
const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
const owner = '73efbd73-729b-4b58-80ab-8c67240ef3db', other = '51c77415-21f8-4305-b165-c29eb5d3c829';
const config: VoiceConfig = { apiKey: 'not-used', sttUsdPerMinute: .0043, ttsUsdPerThousandChars: .03, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 1, sessionUsd: 1, userDailyUsd: 5, userMonthlyUsd: 50, globalDailyUsd: 50 };
describe.skipIf(!enabled)('voice admission on disposable PostgreSQL without speech calls', () => {
  let pool: Pool, servicePool: Pool, store: PostgresPracticeStore, service: SessionService;
  let container = '';
  beforeAll(async () => {
    const password = randomBytes(24).toString('hex'); container = `foundry-voice-test-${randomUUID().slice(0, 12)}`;
    execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--name', container, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=foundry_voice_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' });
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    const connection = { host: '127.0.0.1', port, user: 'postgres', password, database: 'foundry_voice_test', connectionTimeoutMillis: 1000 };
    pool = new Pool(connection);
    let ready = false; for (let attempt = 0; attempt < 80; attempt++) { try { await pool.query('select 1'); ready = true; break; } catch { await delay(100); } }
    if (!ready) throw new Error('Disposable voice database was unavailable.');
    await pool.query("create schema auth; create table auth.users(id uuid primary key); create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public,auth to anon,authenticated,service_role; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant execute on function auth.uid() to anon,authenticated,service_role;");
    for (const name of ['202610090001_ai_practice_foundation.sql', '202610090002_runtime_persistence.sql', '202610090004_voice.sql', '202610090007_event_contract.sql', '202610090008_private_job_reads.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    servicePool = new Pool({ ...connection, options: '-c role=service_role', max: 8 });
    expect((await servicePool.query('select current_user')).rows[0].current_user).toBe('service_role');
    store = new PostgresPracticeStore(servicePool); service = new SessionService(store, getScenario);
  }, 60_000);
  afterAll(async () => { await servicePool?.end(); await pool?.end(); if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); });
  beforeEach(async () => {
    await pool.query('truncate public.ai_practice_sessions cascade; truncate public.ai_practice_requests,public.ai_practice_usage_ledger,public.ai_practice_deletions; delete from auth.users');
    await pool.query('insert into auth.users(id) values ($1),($2)', [owner, other]);
  });
  const create = async (actor = owner) => {
    const session = (await service.createSession(actor, { scenarioId: 'monetary-validation', voice: true, requestId: randomUUID() })).session;
    const finish = await service.command(actor,session.id,{ expectedRevision: session.revision,requestId: randomUUID(),action: 'finish' });
    await service.cancelJob(actor,finish.job!.id,{ requestId: randomUUID() });
    return service.getSession(actor,session.id);
  };
  const input = (ownerId: string, sessionId: string, requestId = randomUUID()) => ({ ownerId, sessionId, requestId, operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 60, characters: 0, usd: .2 });
  it('persists voice preference and rejects text, pre-debrief and legacy attempts before quota writes', async () => {
    const text = (await service.createSession(owner,{ scenarioId: 'monetary-validation',requestId: randomUUID() })).session;
    const selected = (await service.createSession(owner,{ scenarioId: 'monetary-validation',requestId: randomUUID(),voice: true })).session;
    const second = new PostgresPracticeStore(servicePool), restored = await second.read();
    expect(restored.sessions[text.id].configuration.voice).toBe(false);
    expect(restored.sessions[selected.id].configuration.voice).toBe(true);
    await expect(reserveVoice(second,config,input(owner,text.id))).rejects.toMatchObject({ code: 'voice_not_selected',status: 403 });
    await expect(reserveVoice(second,config,input(owner,selected.id))).rejects.toMatchObject({ code: 'voice_debrief_required',status: 409 });
    await store.transaction(db => { delete db.sessions[text.id].configuration.voice; });
    await expect(reserveVoice(second,config,input(owner,text.id))).rejects.toMatchObject({ code: 'voice_not_selected' });
    expect((await second.read()).ledger.filter(entry => entry.operationId.startsWith('voice:'))).toEqual([]);
  });
  it('serializes a global minute cap across independent service-role adapters and roundtrips settlement', async () => {
    const a = await create(), b = await create(other); const second = new PostgresPracticeStore(servicePool);
    const results = await Promise.allSettled([reserveVoice(store, config, input(owner, a.id)), reserveVoice(second, config, input(other, b.id))]);
    const admitted = results.find(result => result.status === 'fulfilled'); expect(admitted?.status).toBe('fulfilled');
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    if (admitted?.status !== 'fulfilled') throw new Error('Expected one admitted voice request.');
    await settleVoice(second, admitted.value, false);
    const reloaded = await new PostgresPracticeStore(servicePool).read();
    expect(reloaded.sessions[admitted.value.sessionId].usage.spentUsd).toBe(.2);
    expect(reloaded.sessions[admitted.value.sessionId].usage.reservedUsd).toBe(0);
    const rows = (await pool.query("select runtime_payload from ai_practice_usage_ledger where runtime_payload ? 'voice'")).rows;
    expect(rows).toHaveLength(2); expect(rows.map(row => row.runtime_payload.voice.state).sort()).toEqual(['reserved', 'settled']);
    expect(JSON.stringify(rows)).not.toContain('transcript');
    await expect(reserveVoice(second, config, input(owner, a.id))).rejects.toMatchObject({ code: 'quota' });
  });
  it('does not reset user minutes on private-content deletion and rejects malformed ledger metadata', async () => {
    const session = await create(); const limited = { ...config, globalDailyMinutes: 100, userDailyMinutes: 1 };
    const reservation = await reserveVoice(store, limited, input(owner, session.id)); await settleVoice(store, reservation, true);
    await service.deleteAccount(owner, { requestId: randomUUID() });
    const next = await create();
    await expect(reserveVoice(new PostgresPracticeStore(servicePool), limited, input(owner, next.id))).rejects.toMatchObject({ code: 'quota' });
    await expect(pool.query("update ai_practice_usage_ledger set runtime_payload = jsonb_set(runtime_payload, '{voice,characters}', '999999'::jsonb) where runtime_payload ? 'voice'")).rejects.toMatchObject({ code: '23514' });
    expect((await store.read()).ledger.some(entry => entry.operationId.startsWith('voice:'))).toBe(true);
  });
  it('recovers a process-crash reservation exactly once across independent adapters and fences the original callback', async () => {
    const session = await create(), at = new Date('2026-10-31T23:59:30.000Z'), expired = new Date(at.getTime() + VOICE_RECONCILIATION_POLICY.leaseMs);
    const reservation = await reserveVoice(store, config, input(owner, session.id), at);
    const second = new PostgresPracticeStore(servicePool), before = await second.read();
    expect((before.ledger.find(entry => entry.operationId === `${reservation.key}:reserved`) as VoiceLedgerEntry).voice.expiresAt).toBe(expired.toISOString());
    expect((await reconcileVoiceReservations(second, { now: expired })).selected).toBe(1); expect(await second.read()).toEqual(before);
    const results = await Promise.all([reconcileVoiceReservations(second, { apply: true, now: expired }), reconcileVoiceReservations(new PostgresPracticeStore(servicePool), { apply: true, now: expired })]);
    expect(results.map(result => result.reconciled).sort()).toEqual([0, 1]);
    expect(await settleVoice(new PostgresPracticeStore(servicePool), reservation, false, expired)).toBe(false);
    const reloaded = await new PostgresPracticeStore(servicePool).read(), entries = reloaded.ledger.filter(entry => entry.operationId.startsWith(reservation.key));
    expect(entries).toHaveLength(2); expect(entries[1]).toMatchObject({ kind: 'uncertain', amountUsd: 0, createdAt: expired.toISOString(), budgetAt: at.toISOString() });
    expect(reloaded.sessions[session.id].usage).toMatchObject({ reservedUsd: 0, uncertainUsd: .2, spentUsd: 0, voiceAllocatedSeconds: 60 });
    expect(budgetTotals(reloaded.ledger, owner, at.toISOString()).userMonthlyUsd).toBe(.2);
    expect(budgetTotals(reloaded.ledger, owner, expired.toISOString()).userMonthlyUsd).toBe(0);
  });
  it('closes a deleted legacy reservation conservatively without recreating private content', async () => {
    const session = await create(), at = new Date('2026-10-09T12:00:00.000Z'), expired = new Date(at.getTime() + VOICE_RECONCILIATION_POLICY.leaseMs);
    const reservation = await reserveVoice(store, config, input(owner, session.id), at);
    await store.transaction(db => { const row = db.ledger.find(entry => entry.operationId === `${reservation.key}:reserved`)! as VoiceLedgerEntry; delete row.voice.expiresAt; delete row.budgetAt; });
    await service.deleteAccount(owner, { requestId: randomUUID() });
    const second = new PostgresPracticeStore(servicePool);
    expect((await reconcileVoiceReservations(second, { apply: true, now: expired })).reconciled).toBe(1);
    const restored = await second.read(); expect(restored.sessions[session.id]).toBeUndefined();
    expect(restored.ledger.find(entry => entry.operationId === `${reservation.key}:uncertain`)).toMatchObject({ amountUsd: 0, budgetAt: at.toISOString() });
    expect(await settleVoice(second, { ...reservation, expiresAt: undefined }, false, expired)).toBe(false);
    expect(budgetTotals(restored.ledger, owner, at.toISOString()).userDailyUsd).toBe(.2);
  });
  it('retains malformed expiry for review instead of shortening the admitted lease', async () => {
    const session = await create(), at = new Date('2026-10-09T12:00:00.000Z'), expired = new Date(at.getTime() + VOICE_RECONCILIATION_POLICY.leaseMs);
    const reservation = await reserveVoice(store, config, input(owner, session.id), at);
    await store.transaction(db => { const row = db.ledger.find(entry => entry.operationId === `${reservation.key}:reserved`)! as VoiceLedgerEntry; row.voice.expiresAt = at.toISOString(); });
    const second = new PostgresPracticeStore(servicePool), before = await second.read();
    expect(await reconcileVoiceReservations(second, { apply: true, now: expired })).toMatchObject({ ambiguous: 1, reconciled: 0 });
    expect(await second.read()).toEqual(before);
  });
});
