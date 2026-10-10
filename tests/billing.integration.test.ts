import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { BillingService } from '../lib/billing/service';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { billingConfig, billingScenario, FakeBillingGateway, paidFixture, signedEvent } from './billing-fixtures';

const enabled = process.env.RUN_POSTGRES_INTEGRATION === '1';
const owner = '73efbd73-729b-4b58-80ab-8c67240ef3db', other = '51c77415-21f8-4305-b165-c29eb5d3c829';
const req = () => randomUUID();
describe.skipIf(!enabled)('commerce on disposable PostgreSQL; Stripe network calls are synthetic fixtures', () => {
  let pool: Pool, runtimePool: Pool, store: PostgresPracticeStore, billing: BillingService, service: SessionService, gateway: FakeBillingGateway;
  let container = '';
  beforeAll(async () => {
    container = `foundry-billing-test-${randomUUID().slice(0, 12)}`;
    execFileSync('docker', ['run', '--pull=never', '--rm', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=disposable_billing_only', '-e', 'POSTGRES_DB=foundry_test', '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' });
    const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split(':').at(-1));
    const connection = { host: '127.0.0.1', port, user: 'postgres', password: 'disposable_billing_only', database: 'foundry_test', connectionTimeoutMillis: 1000 };
    pool = new Pool(connection);
    let ready = false;
    for (let i = 0; i < 80; i++) { try { await pool.query('select 1'); ready = true; break; } catch { await delay(100); } }
    if (!ready) throw new Error('Disposable PostgreSQL did not start.');
    await pool.query("create schema auth; create table auth.users(id uuid primary key); create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; grant usage on schema public,auth to anon,authenticated,service_role; create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant execute on function auth.uid() to anon,authenticated,service_role;");
    for (const name of ['202610090001_ai_practice_foundation.sql', '202610090002_runtime_persistence.sql', '202610090003_commerce.sql', '202610090007_event_contract.sql']) await pool.query(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    runtimePool = new Pool({ ...connection, options: '-c role=service_role', max: 12 });
    expect((await runtimePool.query('select current_user')).rows[0].current_user).toBe('service_role');
  }, 60_000);
  afterAll(async () => { await runtimePool?.end(); await pool?.end(); if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }); });
  beforeEach(async () => {
    await pool.query('truncate public.ai_practice_sessions cascade; truncate public.ai_practice_requests,public.ai_practice_usage_ledger,public.ai_practice_deletions,public.practice_billing_webhook_events; delete from auth.users');
    await pool.query('insert into auth.users(id) values ($1),($2)', [owner, other]);
    gateway = new FakeBillingGateway(); paidFixture(gateway); billing = new BillingService(runtimePool, billingConfig, gateway);
    store = new PostgresPracticeStore(runtimePool); service = new SessionService(store, () => billingScenario, { admissionPolicy: billing.admissionPolicy(store) });
  });
  const create = (requestId = req()) => service.createSession(owner, { scenarioId: billingScenario.id, requestId });
  const enqueue = async (id = 'evt_paid', type = 'invoice.paid', objectId = 'in_foundry', extra = {}) => { const event = signedEvent(gateway, id, type, objectId, extra); return billing.receiveWebhook(event.payload, event.signature); };
  const grant = async () => { await pool.query('insert into public.practice_billing_customers(user_id,stripe_customer_id,livemode) values ($1,$2,false)', [owner, 'cus_foundryA']); await enqueue(); await billing.processNextWebhook('billing-worker'); };
  it('queues verified metadata durably and deduplicates deliveries without storing raw PII or trusting owner metadata', async () => {
    await enqueue(); await enqueue();
    expect(gateway.calls.invoice).toBe(0);
    const rows = (await pool.query('select * from public.practice_billing_webhook_events')).rows;
    expect(rows).toHaveLength(1); expect(rows[0].state).toBe('pending'); expect(JSON.stringify(rows)).not.toContain('DO-NOT-PERSIST');
    await billing.processNextWebhook('worker'); expect((await billing.status(owner)).paidRemaining).toBe(0);
  });
  it('rejects wrong mode and connected-account events before queueing', async () => {
    await expect(enqueue('evt_live', 'invoice.paid', 'in_foundry', { livemode: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(enqueue('evt_connect', 'invoice.paid', 'in_foundry', { account: 'acct_other' })).rejects.toMatchObject({ code: 'invalid' });
    expect((await pool.query('select count(*)::int as count from practice_billing_webhook_events')).rows[0].count).toBe(0);
  });
  it('retrieves current resources for reordered same-second events and never grants twice for one paid period', async () => {
    await grant(); expect((await billing.status(owner)).paidRemaining).toBe(2);
    gateway.subscriptions.get('sub_foundry')!.status = 'canceled';
    await enqueue('evt_oldcreated', 'customer.subscription.created', 'sub_foundry'); await billing.processNextWebhook('worker');
    expect((await billing.status(owner)).paidRemaining).toBe(0);
    gateway.subscriptions.get('sub_foundry')!.status = 'active';
    await enqueue('evt_retrypaid'); await billing.processNextWebhook('worker');
    expect((await pool.query('select count(*)::int as count from practice_billing_grants')).rows[0].count).toBe(1);
    expect((await billing.status(owner)).paidRemaining).toBe(2);
  });
  it('does not grant for unpaid invoices, unsupported prices, quantity or prorations', async () => {
    await pool.query('insert into practice_billing_customers(user_id,stripe_customer_id,livemode) values ($1,$2,false)', [owner, 'cus_foundryA']);
    gateway.invoices.get('in_foundry')!.status = 'open'; await enqueue(); await billing.processNextWebhook('worker');
    gateway.invoices.get('in_foundry')!.status = 'paid'; gateway.invoices.get('in_foundry')!.lines[0].proration = true;
    await enqueue('evt_proration'); await billing.processNextWebhook('worker');
    gateway.invoices.get('in_foundry')!.lines[0].proration = false; gateway.subscriptions.get('sub_foundry')!.quantity = 2;
    await enqueue('evt_quantity'); await billing.processNextWebhook('worker');
    gateway.subscriptions.get('sub_foundry')!.quantity = 1; gateway.subscriptions.get('sub_foundry')!.priceId = 'price_other';
    await enqueue('evt_price'); await billing.processNextWebhook('worker');
    expect((await billing.status(owner)).paidRemaining).toBe(0);
  });
  it('atomically consumes paid admission with the practice ledger, replays keys and rejects concurrent overspend', async () => {
    await grant(); const key = req(), first = await create(key); expect(await create(key)).toEqual(first);
    const results = await Promise.allSettled([create(), create()]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await pool.query('select count(*)::int as count from practice_billing_consumptions')).rows[0].count).toBe(2);
    expect((await pool.query("select count(*)::int as count from ai_practice_usage_ledger where kind='admission'")).rows[0].count).toBe(2);
    expect((await billing.status(owner)).remaining).toBe(0);
  });
  it('rolls commerce consumption back when the surrounding practice transaction fails', async () => {
    await grant();
    await expect(store.transaction(async database => { await billing.admissionPolicy(store)({ ownerId: owner, sessionId: req(), scenarioId: billingScenario.id, scenarioVersion: billingScenario.version, requestId: req(), now: new Date().toISOString(), database }); throw new Error('Synthetic after-admission failure'); })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await pool.query('select count(*)::int as count from practice_billing_consumptions')).rows[0].count).toBe(0);
    expect((await billing.status(owner)).remaining).toBe(2);
  });
  it('retains financial usage after attempt and all Lab-data deletion', async () => {
    await grant(); const one = await create(); await service.deleteSession(owner, one.session.id, { requestId: req() });
    await create(); await service.deleteAccount(owner, { requestId: req() });
    await expect(create()).rejects.toMatchObject({ code: 'quota' });
    expect((await pool.query('select count(*)::int as count from practice_billing_consumptions')).rows[0].count).toBe(2);
    expect((await pool.query('select count(*)::int as count from ai_practice_sessions')).rows[0].count).toBe(0);
  });
  it('offers a configured calendar-month free allowance without creating a Stripe customer', async () => {
    billing = new BillingService(runtimePool, { ...billingConfig, freeSessionsPerMonth: 1 }, gateway);
    service = new SessionService(store, () => billingScenario, { admissionPolicy: billing.admissionPolicy(store) });
    await create(); await expect(create()).rejects.toMatchObject({ code: 'quota' });
    await service.deleteAccount(owner, { requestId: req() }); await expect(create()).rejects.toMatchObject({ code: 'quota' });
    expect((await billing.status(owner)).freeRemaining).toBe(0); expect(gateway.calls.customer).toBe(0);
  });
  it('creates checkout/portal only on explicit service triggers and reuses checkout links/idempotency', async () => {
    await billing.status(owner); expect(gateway.calls).toMatchObject({ customer: 0, checkout: 0, portal: 0 });
    const key = req(), result = await billing.checkout(owner, key);
    expect(await billing.checkout(owner, key)).toEqual(result); expect(await billing.checkout(owner, req())).toEqual(result);
    expect(gateway.calls).toMatchObject({ customer: 1, checkout: 1, price: 1 });
    const portal = req(); await billing.portal(owner, portal); await billing.portal(owner, portal); expect(gateway.calls.portal).toBe(1);
    expect(gateway.checkoutKeys[0]).not.toContain(owner);
  });
  it('preserves an uncertain operation for retry under the same stable provider key', async () => {
    const key = req(); gateway.failCheckout = true; await expect(billing.checkout(owner, key)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(billing.checkout(owner, req())).rejects.toMatchObject({ code: 'conflict' });
    gateway.failCheckout = false; await billing.checkout(owner, key);
    expect(gateway.checkoutKeys[0]).toBe(gateway.checkoutKeys[1]); expect(gateway.calls.customer).toBe(1);
  });
  it('blocks new paid admission after refund/dispute and does not revive access from a delayed invoice event', async () => {
    await grant(); await enqueue('evt_refund', 'charge.refunded', 'ch_foundry'); await billing.processNextWebhook('worker');
    expect((await billing.status(owner)).blocked).toBe(true); await expect(create()).rejects.toMatchObject({ code: 'quota' });
    await enqueue('evt_delayedpaid'); await billing.processNextWebhook('worker'); expect((await billing.status(owner)).paidRemaining).toBe(0);
  });
  it('enforces actual owner-only commerce reads, no client writes and private webhook inbox', async () => {
    await grant(); await create();
    const client = await pool.connect();
    try {
      await client.query('begin; set local role authenticated'); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [other]);
      expect((await client.query('select count(*)::int as count from practice_billing_consumptions')).rows[0].count).toBe(0);
      await expect(client.query('select * from practice_billing_webhook_events')).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback; begin; set local role authenticated'); await client.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]);
      expect((await client.query('select count(*)::int as count from practice_billing_consumptions')).rows[0].count).toBe(1);
      await expect(client.query('delete from practice_billing_consumptions')).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback; begin; set local role anon'); await expect(client.query('select * from practice_billing_grants')).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('rollback'); client.release(); }
  });
  it('retries transient reconciliation durably with backoff and only one active processor', async () => {
    await pool.query('insert into practice_billing_customers(user_id,stripe_customer_id,livemode) values ($1,$2,false)', [owner, 'cus_foundryA']);
    const original = gateway.invoices.get('in_foundry')!; gateway.invoices.delete('in_foundry'); await enqueue();
    await expect(billing.processNextWebhook('worker')).rejects.toMatchObject({ code: 'unavailable' });
    expect(await billing.processNextWebhook('worker')).toBe(false);
    const queued = (await pool.query('select state,attempt,next_attempt_at>now() as delayed from practice_billing_webhook_events')).rows[0];
    expect(queued).toEqual({ state: 'pending', attempt: 1, delayed: true });
    gateway.invoices.set('in_foundry', original); await pool.query('update practice_billing_webhook_events set next_attempt_at=now()');
    const results = await Promise.all([billing.processNextWebhook('one'), billing.processNextWebhook('two')]);
    expect(results.filter(Boolean)).toHaveLength(1); expect((await billing.status(owner)).paidRemaining).toBe(2);
  });
  it('exports only the owner financial records and preserves granted allowance across configuration changes', async () => {
    await grant(); await create();
    const updatedConfiguration = new BillingService(runtimePool, { ...billingConfig, priceId: 'price_new', sessionsPerPeriod: 10 }, gateway);
    expect((await updatedConfiguration.status(owner)).paidRemaining).toBe(1);
    const exported = await billing.exportAccount(owner), otherExport = await billing.exportAccount(other);
    expect(exported.consumptions).toHaveLength(1); expect(exported.grants[0].session_allowance).toBe(2);
    expect(otherExport).toEqual({ customer: null, subscriptions: [], grants: [], consumptions: [] });
    expect(JSON.stringify(exported)).not.toContain('checkout.stripe.com');
  });
});
