import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { budgetTotals } from '../lib/interview-practice/quota';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { runRetention } from '../lib/server/retention';
import { finalAttempt, harness, openCase, owner, scenario } from './review-fixtures';

// Explicit opt-in creates only a new disposable local database. Never reads
// DATABASE_URL or calls any provider. Authored tests are not SQL qualification
// until an opted-in run passes; do not enable under a no-Docker instruction.
const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
const now = new Date('2026-10-09T12:30:00.000Z'), old = '2026-07-01T12:30:00.000Z';
describe.skipIf(!enabled)('retention synchronization with service-role PostgreSQL permissions', () => {
  let container = '', pool: Pool, servicePool: Pool, store: PostgresPracticeStore, context: ReturnType<typeof harness>;
  beforeAll(async () => {
    container = `foundry-retention-test-${randomUUID().slice(0, 12)}`;
    execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=disposable_foundry_test_only', '-e', 'POSTGRES_DB=foundry_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' });
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'disposable_foundry_test_only', database: 'foundry_test' };
    pool = new Pool({ ...connection, max: 8, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) { try { await pool.query('select 1'); ready = true; break; } catch { await delay(100); } }
    if (!ready) throw new Error('Disposable retention database did not become ready.');
    await pool.query("create schema auth; create table auth.users(id uuid primary key); create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public,auth to anon,authenticated,service_role; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant execute on function auth.uid() to anon,authenticated,service_role;");
    for (const file of ['202610090001_ai_practice_foundation.sql', '202610090002_runtime_persistence.sql', '202610090006_reviews.sql', '202610090007_event_contract.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'));
    servicePool = new Pool({ ...connection, max: 8, options: '-c role=service_role' });
    expect((await servicePool.query('select current_user')).rows[0].current_user).toBe('service_role');
    store = new PostgresPracticeStore(servicePool); context = harness(store, () => new Date(old));
  }, 60_000);
  afterAll(async () => { await servicePool?.end(); await pool?.end(); if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); });
  beforeEach(async () => {
    await pool.query('truncate public.ai_practice_sessions cascade; truncate public.ai_practice_requests,public.ai_practice_usage_ledger,public.ai_practice_deletions,public.ai_practice_review_audits; delete from auth.users');
    await pool.query('insert into auth.users(id) values ($1)', [owner]);
  });
  const counts = async () => (await pool.query('select (select count(*) from ai_practice_requests)::int as requests,(select count(*) from ai_practice_usage_ledger)::int as ledger,(select count(*) from ai_practice_deletions)::int as deletions')).rows[0];

  it('deletes only eligible SQL operational rows while saved evidence, active replay and current quota survive independent reload', async () => {
    const terminal = await finalAttempt(context), key = randomUUID();
    const active = await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: key });
    await store.transaction(db => {
      const current = now.toISOString(), prefix = `synthetic:${randomUUID()}`;
      db.ledger.push({ id: randomUUID(), ownerId: owner, sessionId: terminal.id, operationId: `${prefix}:reserve`, kind: 'reservation', amountUsd: .08, createdAt: current, budgetAt: current });
    });
    const before = await store.read(), beforeCounts = await counts(), beforeQuota = budgetTotals(before.ledger, owner, now.toISOString());
    const dry = await runRetention(store, { now }); expect(dry.selected.requests).toBeGreaterThan(0); expect(dry.selected.ledger).toBeGreaterThan(0); expect(await counts()).toEqual(beforeCounts);
    const applied = await runRetention(store, { apply: true, now }), afterCounts = await counts();
    expect(afterCounts).toEqual({ requests: beforeCounts.requests - applied.removed.requests, ledger: beforeCounts.ledger - applied.removed.ledger, deletions: 0 });
    const reloaded = new PostgresPracticeStore(servicePool), after = await reloaded.read();
    expect(after.sessions).toEqual(before.sessions); expect(budgetTotals(after.ledger, owner, now.toISOString())).toEqual(beforeQuota);
    expect(after.requests[`${owner}:${key}`]).toBeDefined();
    expect(await harness(reloaded, () => now).practice.createSession(owner, { scenarioId: scenario.id, requestId: key })).toEqual(active);
    expect((await runRetention(reloaded, { apply: true, now })).removed).toEqual({ requests: 0, ledger: 0, deletions: 0 });
  });

  it('persists bounded cache and tombstone deletion in the correct dependency order without splitting a settled group', async () => {
    const sessionId = randomUUID(), requestId = randomUUID(), deletionId = randomUUID(), prefix = `synthetic:${randomUUID()}`;
    await store.transaction(db => {
      db.requests[`${owner}:${requestId}`] = { ownerId: owner, requestId, fingerprint: 'a'.repeat(64), createdAt: old, result: { sessionId, copiedContent: 'SYNTHETIC-DELETED-RESPONSE' } };
      db.deletions.push({ id: deletionId, ownerId: owner, sessionId, state: 'completed', objectKeys: [], createdAt: old, completedAt: old });
      db.ledger.push(...(['reservation', 'settlement'] as const).map(kind => ({ id: randomUUID(), ownerId: owner, sessionId, operationId: `${prefix}:${kind === 'reservation' ? 'reserve' : 'settle'}`, kind, amountUsd: kind === 'reservation' ? .08 : -.06, createdAt: old, budgetAt: old })));
    });
    const first = await runRetention(store, { apply: true, maxRows: 1, now });
    expect(first.removed).toEqual({ requests: 1, ledger: 0, deletions: 0 }); expect(await counts()).toEqual({ requests: 0, ledger: 2, deletions: 1 });
    const second = await runRetention(new PostgresPracticeStore(servicePool), { apply: true, maxRows: 3, now });
    expect(second.removed).toEqual({ requests: 0, ledger: 2, deletions: 1 }); expect(await counts()).toEqual({ requests: 0, ledger: 0, deletions: 0 });
  });

  it('preserves an open support case and its immutable audit while retaining its expired caches and usage groups', async () => {
    const terminal = await finalAttempt(context); await openCase(context, terminal.id);
    const before = await store.read(), result = await runRetention(store, { apply: true, now }), after = await new PostgresPracticeStore(servicePool).read();
    expect(result.removed).toEqual({ requests: 0, ledger: 0, deletions: 0 }); expect(result.retained.active_obligation).toBeGreaterThan(0);
    expect(after.reviews).toEqual(before.reviews); expect(after.sessions).toEqual(before.sessions); expect(after.requests).toEqual(before.requests); expect(after.ledger).toEqual(before.ledger);
  });
});
