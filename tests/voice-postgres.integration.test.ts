import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { getScenario } from '../lib/content/scenarios';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { reserveVoice, settleVoice } from '../lib/voice/ledger';
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
    for (const name of ['202610090001_ai_practice_foundation.sql', '202610090002_runtime_persistence.sql', '202610090004_voice.sql', '202610090007_event_contract.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    servicePool = new Pool({ ...connection, options: '-c role=service_role', max: 8 });
    expect((await servicePool.query('select current_user')).rows[0].current_user).toBe('service_role');
    store = new PostgresPracticeStore(servicePool); service = new SessionService(store, getScenario);
  }, 60_000);
  afterAll(async () => { await servicePool?.end(); await pool?.end(); if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); });
  beforeEach(async () => {
    await pool.query('truncate public.ai_practice_sessions cascade; truncate public.ai_practice_requests,public.ai_practice_usage_ledger,public.ai_practice_deletions; delete from auth.users');
    await pool.query('insert into auth.users(id) values ($1),($2)', [owner, other]);
  });
  const create = async (actor = owner) => (await service.createSession(actor, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
  const input = (ownerId: string, sessionId: string, requestId = randomUUID()) => ({ ownerId, sessionId, requestId, operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 60, characters: 0, usd: .2 });
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
});
