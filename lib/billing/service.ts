import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { assertRequestId, digest, DomainError } from '../interview-practice/domain';
import type { SessionAdmissionContext } from '../server/session-service';
import type { BillingConfiguration } from './config';
import type { BillingGateway, BillingInvoice, BillingSubscription } from './stripe';

type TransactionStore = { currentTransactionClient(): PoolClient | undefined };
type InboxEvent = { event_id: string; event_type: string; object_id: string; claim_token: string };
type Allowance = { key: string; source: 'free' | 'paid'; start: string; end: string; allowance: number; used: number };
export type BillingStatus = { enabled: true; freeSessionsPerMonth: number; sessionsPerPaidPeriod: number; remaining: number; paidRemaining: number; freeRemaining: number; blocked: boolean; subscriptionStatus: string; periodEnd: string | null; hasCustomer: boolean };
const relevant = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'invoice.voided', 'invoice.marked_uncollectible', 'charge.refunded', 'charge.dispute.created', 'customer.deleted']);
const keyFor = (value: string) => `foundry-practice-${createHash('sha256').update(value).digest('hex')}`;
const safeFailure = () => new DomainError('unavailable', 'Billing is temporarily unavailable. Retry the same request key; no payment details were logged.');
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const ownerPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
function assertOwner(owner: string) { if (!ownerPattern.test(owner)) throw new DomainError('invalid', 'A verified Foundry account is required.'); }
function freePeriod(now: string) {
  const date = new Date(now), year = date.getUTCFullYear(), month = date.getUTCMonth();
  return { key: `free:${year}-${String(month + 1).padStart(2, '0')}`, start: new Date(Date.UTC(year, month, 1)).toISOString(), end: new Date(Date.UTC(year, month + 1, 1)).toISOString() };
}
export class BillingService {
  constructor(readonly pool: Pool, readonly configuration: BillingConfiguration, readonly gateway: BillingGateway, private readonly now = () => new Date()) {}
  private async transaction<T>(apply: (client: PoolClient) => Promise<T>, practiceLock = false) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true),set_config('idle_in_transaction_session_timeout','15000',true)");
      if (practiceLock) await client.query('select pg_advisory_xact_lock($1)', [this.configuration.advisoryLockKey]);
      const result = await apply(client); await client.query('commit'); return result;
    } catch (error) { await client.query('rollback').catch(() => undefined); if (error instanceof DomainError) throw error; throw safeFailure(); }
    finally { client.release(); }
  }
  private async allowances(client: PoolClient, ownerId: string, now: string): Promise<Allowance[]> {
    const paid = await client.query<{ id: string; period_start: Date; period_end: Date; session_allowance: number; used: string }>(`select g.id,g.period_start,g.period_end,g.session_allowance,
      (select count(*)::text from public.practice_billing_consumptions c where c.user_id=g.user_id and c.period_key='paid:'||g.id::text) as used
      from public.practice_billing_grants g join public.practice_billing_customers customer using(user_id)
      join public.practice_billing_subscriptions s on s.stripe_subscription_id=g.stripe_subscription_id and s.user_id=g.user_id
      where g.user_id=$1 and not g.revoked and not customer.blocked and s.status='active' and g.period_start <= $2 and g.period_end > $2 order by g.period_end,g.id`, [ownerId, now]);
    const result: Allowance[] = paid.rows.map(row => ({ key: `paid:${row.id}`, source: 'paid', start: row.period_start.toISOString(), end: row.period_end.toISOString(), allowance: row.session_allowance, used: Number(row.used) }));
    const free = freePeriod(now), count = await client.query<{ count: string }>('select count(*)::text as count from public.practice_billing_consumptions where user_id=$1 and period_key=$2', [ownerId, free.key]);
    if (this.configuration.freeSessionsPerMonth) result.push({ ...free, source: 'free', allowance: this.configuration.freeSessionsPerMonth, used: Number(count.rows[0].count) });
    return result;
  }
  /** Runs inside the practice SQL transaction: both this debit and its admission ledger commit together. */
  admissionPolicy(store: TransactionStore) {
    return async ({ ownerId, sessionId, requestId, now }: SessionAdmissionContext) => {
      assertOwner(ownerId);
      const client = store.currentTransactionClient();
      if (!client) throw new DomainError('unavailable', 'Commerce admission requires the PostgreSQL transaction adapter.');
      const existing = await client.query('select 1 from public.practice_billing_consumptions where user_id=$1 and (request_id=$2 or opaque_session_id=$3)', [ownerId, requestId, sessionId]);
      if (existing.rowCount) throw new DomainError('conflict', 'This admission was already consumed. Use a new request key after deleting an attempt.');
      const allowance = (await this.allowances(client, ownerId, now)).find(period => period.used < period.allowance);
      if (!allowance) throw new DomainError('quota', 'No practice sessions remain in your current allowance. Existing work and reports remain available.');
      await client.query("insert into public.practice_billing_consumptions(user_id,opaque_session_id,request_id,period_key,source,period_start,period_end,consumed_at,retention_deadline) values ($1,$2,$3,$4,$5,$6,$7,$8,$7::timestamptz+interval '62 days')", [ownerId, sessionId, requestId, allowance.key, allowance.source, allowance.start, allowance.end, now]);
    };
  }
  async status(ownerId: string): Promise<BillingStatus> {
    assertOwner(ownerId);
    return this.transaction(async client => {
      const periods = await this.allowances(client, ownerId, this.now().toISOString());
      const customer = (await client.query<{ blocked: boolean; stripe_customer_id: string | null }>('select blocked,stripe_customer_id from public.practice_billing_customers where user_id=$1', [ownerId])).rows[0];
      const subscription = (await client.query<{ status: string; period_end: Date }>('select status,period_end from public.practice_billing_subscriptions where user_id=$1 order by reconciled_at desc limit 1', [ownerId])).rows[0];
      const remaining = (source: string) => periods.filter(p => p.source === source).reduce((sum, p) => sum + Math.max(0, p.allowance - p.used), 0);
      return { enabled: true, freeSessionsPerMonth: this.configuration.freeSessionsPerMonth, sessionsPerPaidPeriod: this.configuration.sessionsPerPeriod, remaining: remaining('free') + remaining('paid'), paidRemaining: remaining('paid'), freeRemaining: remaining('free'), blocked: Boolean(customer?.blocked), subscriptionStatus: subscription?.status ?? 'none', periodEnd: subscription?.period_end?.toISOString() ?? null, hasCustomer: Boolean(customer?.stripe_customer_id) };
    });
  }
  async exportAccount(ownerId: string) {
    assertOwner(ownerId);
    return this.transaction(async client => {
      const customers = await client.query('select stripe_customer_id,livemode,blocked,created_at,updated_at from public.practice_billing_customers where user_id=$1', [ownerId]);
      const subscriptions = await client.query('select stripe_subscription_id,price_id,status,period_start,period_end,cancel_at_period_end,reconciled_at from public.practice_billing_subscriptions where user_id=$1', [ownerId]);
      const grants = await client.query('select stripe_invoice_id,stripe_subscription_id,price_id,period_start,period_end,session_allowance,revoked from public.practice_billing_grants where user_id=$1', [ownerId]);
      const consumptions = await client.query('select opaque_session_id,source,period_start,period_end,consumed_at,retention_deadline from public.practice_billing_consumptions where user_id=$1', [ownerId]);
      return { customer: customers.rows[0] ?? null, subscriptions: subscriptions.rows, grants: grants.rows, consumptions: consumptions.rows };
    });
  }
  private async ownerOperation<T>(ownerId: string, apply: (client: PoolClient) => Promise<T>): Promise<T> {
    assertOwner(ownerId); const client = await this.pool.connect(); let locked = false;
    try {
      // Session lock serializes only this customer's explicit commerce actions, never practice writes.
      await client.query("select set_config('lock_timeout','5000',false),set_config('statement_timeout','15000',false)");
      await client.query('select pg_advisory_lock(hashtextextended($1, 815))', [ownerId]); locked = true;
      return await apply(client);
    } catch (error) { if (error instanceof DomainError) throw error; throw safeFailure(); }
    finally { if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1, 815))', [ownerId]).catch(() => undefined); client.release(); }
  }
  private async customer(client: PoolClient, ownerId: string): Promise<string> {
    await client.query('insert into public.practice_billing_customers(user_id,livemode) values ($1,$2) on conflict(user_id) do nothing', [ownerId, this.configuration.livemode]);
    const customer = (await client.query<{ stripe_customer_id: string | null; creation_started_at: Date; blocked: boolean; livemode: boolean }>('select stripe_customer_id,creation_started_at,blocked,livemode from public.practice_billing_customers where user_id=$1', [ownerId])).rows[0];
    if (customer.blocked || customer.livemode !== this.configuration.livemode) throw new DomainError('conflict', 'This billing account needs support before creating another checkout.');
    if (customer.stripe_customer_id) return customer.stripe_customer_id;
    if (this.now().getTime() - customer.creation_started_at.getTime() > 23 * 3_600_000) throw new DomainError('unavailable', 'An interrupted customer setup requires reconciliation before another checkout.');
    const id = await this.gateway.createCustomer(ownerId, keyFor(`customer:${ownerId}`));
    await client.query('update public.practice_billing_customers set stripe_customer_id=$2,updated_at=now() where user_id=$1', [ownerId, id]); return id;
  }
  private async action<T>(ownerId: string, requestId: string, operation: 'checkout' | 'portal', apply: (client: PoolClient, key: string) => Promise<T>, lifetimeMs: number): Promise<T> {
    assertRequestId(requestId);
    return this.ownerOperation(ownerId, async client => {
      const fingerprint = digest({ operation, priceId: operation === 'checkout' ? this.configuration.priceId : null, origin: this.configuration.origin, livemode: this.configuration.livemode });
      const previous = (await client.query<{ operation: string; fingerprint: string; state: string; result: T; created_at: Date; expires_at: Date | null }>('select operation,fingerprint,state,result,created_at,expires_at from public.practice_billing_actions where user_id=$1 and request_id=$2', [ownerId, requestId])).rows[0];
      if (previous && previous.fingerprint !== fingerprint) throw new DomainError('conflict', 'The request key was used for a different billing action.');
      if (previous?.state === 'completed') {
        if (!previous.expires_at || previous.expires_at.getTime() <= this.now().getTime()) throw new DomainError('conflict', 'This link expired. Select the billing action again with a new request key.');
        return previous.result;
      }
      const pending = (await client.query<{ request_id: string; created_at: Date }>("select request_id,created_at from public.practice_billing_actions where user_id=$1 and state='pending' order by created_at limit 1", [ownerId])).rows[0];
      if (pending && pending.request_id !== requestId) throw new DomainError('conflict', 'A billing operation is awaiting a safe retry. Retry its original request key or contact support.');
      if (pending && this.now().getTime() - pending.created_at.getTime() > 23 * 3_600_000) throw new DomainError('unavailable', 'An uncertain billing operation requires reconciliation before another checkout.');
      await client.query("insert into public.practice_billing_actions(user_id,request_id,operation,fingerprint,state) values ($1,$2,$3,$4,'pending') on conflict(user_id,request_id) do nothing", [ownerId, requestId, operation, fingerprint]);
      let result: T;
      try { result = await apply(client, keyFor(`${operation}:${ownerId}:${requestId}`)); }
      catch (error) {
        if (error instanceof DomainError && error.code !== 'unavailable') await client.query("delete from public.practice_billing_actions where user_id=$1 and request_id=$2 and state='pending'", [ownerId, requestId]);
        throw error;
      }
      const providerExpiry = (result as { expiresAt?: number })?.expiresAt;
      const expires = Math.min(this.now().getTime() + lifetimeMs, providerExpiry ? providerExpiry * 1000 : Infinity);
      await client.query("update public.practice_billing_actions set state='completed',result=$3,expires_at=$4 where user_id=$1 and request_id=$2", [ownerId, requestId, JSON.stringify(result), new Date(expires).toISOString()]);
      return result;
    });
  }
  async checkout(ownerId: string, requestId: string) {
    return this.action(ownerId, requestId, 'checkout', async (client, key) => {
      const active = await client.query("select 1 from public.practice_billing_subscriptions where user_id=$1 and status in ('active','trialing','past_due','unpaid','incomplete','paused') limit 1", [ownerId]);
      if (active.rowCount) throw new DomainError('conflict', 'A subscription already exists. Manage it through the billing portal.');
      const open = (await client.query<{ result: { id: string; url: string; expiresAt: number } }>("select result from public.practice_billing_actions where user_id=$1 and operation='checkout' and state='completed' and expires_at>now() order by created_at desc limit 1", [ownerId])).rows[0];
      if (open) return open.result;
      await this.gateway.validatePrice();
      return this.gateway.createCheckout(ownerId, await this.customer(client, ownerId), key);
    }, 24 * 3_600_000);
  }
  async portal(ownerId: string, requestId: string) {
    return this.action(ownerId, requestId, 'portal', async (client, key) => {
      const customer = (await client.query<{ stripe_customer_id: string | null }>('select stripe_customer_id from public.practice_billing_customers where user_id=$1', [ownerId])).rows[0];
      if (!customer?.stripe_customer_id) throw new DomainError('not_found', 'No billing customer exists for this Foundry account.');
      return this.gateway.createPortal(customer.stripe_customer_id, key);
    }, 5 * 60_000);
  }
  async receiveWebhook(payload: Buffer, signature: string) {
    if (payload.byteLength > 256_000) throw new DomainError('invalid', 'Billing event is too large.');
    const event = this.gateway.verify(payload, signature);
    const object = event.data?.object as { id?: unknown } | undefined;
    if (!/^evt_[A-Za-z0-9]+$/.test(event.id) || typeof object?.id !== 'string' || !/^[A-Za-z0-9_]+$/.test(object.id) || !Number.isSafeInteger(event.created) || event.created <= 0 || event.livemode !== this.configuration.livemode || event.account) throw new DomainError('invalid', 'The billing event account, mode, or envelope is unsupported.');
    const fingerprint = digest({ type: event.type, objectId: object.id, livemode: event.livemode, created: event.created });
    return this.transaction(async client => {
      const existing = (await client.query<{ fingerprint: string }>('select fingerprint from public.practice_billing_webhook_events where event_id=$1', [event.id])).rows[0];
      if (existing && existing.fingerprint !== fingerprint) throw new DomainError('conflict', 'The billing event ID conflicts with a prior delivery.');
      await client.query("insert into public.practice_billing_webhook_events(event_id,event_type,object_id,fingerprint,livemode,event_created_at,state) values ($1,$2,$3,$4,$5,$6,$7) on conflict(event_id) do nothing", [event.id, event.type, object.id, fingerprint, event.livemode, iso(event.created), relevant.has(event.type) ? 'pending' : 'ignored']);
      const recorded = (await client.query<{ fingerprint: string }>('select fingerprint from public.practice_billing_webhook_events where event_id=$1', [event.id])).rows[0];
      if (recorded.fingerprint !== fingerprint) throw new DomainError('conflict', 'The billing event ID conflicts with a prior delivery.');
      return { received: true as const };
    });
  }
  private eligible(invoice: BillingInvoice, subscription: BillingSubscription) {
    return subscription.status === 'active' && subscription.priceId === this.configuration.priceId && subscription.quantity === 1 && subscription.livemode === this.configuration.livemode && invoice.livemode === this.configuration.livemode && invoice.customerId === subscription.customerId && invoice.subscriptionId === subscription.id && invoice.status === 'paid' && ['subscription_create', 'subscription_cycle'].includes(invoice.reason || '') && subscription.periodStart > 0 && subscription.periodEnd > subscription.periodStart && invoice.lines.some(line => line.priceId === this.configuration.priceId && line.quantity === 1 && !line.proration && line.start === subscription.periodStart && line.end === subscription.periodEnd);
  }
  private async reconcile(event: InboxEvent) {
    if (event.event_type === 'customer.deleted' || event.event_type === 'charge.refunded' || event.event_type === 'charge.dispute.created') {
      const risk = await this.gateway.riskCustomer(event.event_type, event.object_id);
      return this.transaction(async client => {
        if (risk.customerId && risk.blocked) await client.query('update public.practice_billing_customers set blocked=true,updated_at=now() where stripe_customer_id=$1', [risk.customerId]);
        await this.finishEvent(client, event); return true;
      }, true);
    }
    let invoice: BillingInvoice | null = null, subscriptionId: string | null;
    if (event.event_type.startsWith('invoice.')) { invoice = await this.gateway.invoice(event.object_id); subscriptionId = invoice.subscriptionId; }
    else if (event.event_type.startsWith('checkout.')) subscriptionId = await this.gateway.checkoutSubscription(event.object_id);
    else subscriptionId = event.object_id;
    if (!subscriptionId) return this.transaction(async client => { await this.finishEvent(client, event, 'ignored'); return true; });
    const subscription = await this.gateway.subscription(subscriptionId);
    if (!invoice && subscription.latestInvoiceId) invoice = await this.gateway.invoice(subscription.latestInvoiceId);
    if (subscription.livemode !== this.configuration.livemode || (invoice && invoice.livemode !== this.configuration.livemode)) throw new DomainError('invalid', 'Billing resource mode does not match the configured merchant.');
    return this.transaction(async client => {
      const owner = (await client.query<{ user_id: string }>('select user_id from public.practice_billing_customers where stripe_customer_id=$1 and livemode=$2', [subscription.customerId, this.configuration.livemode])).rows[0];
      if (!owner) { await this.finishEvent(client, event, 'ignored'); return true; }
      await client.query(`insert into public.practice_billing_subscriptions(stripe_subscription_id,user_id,stripe_customer_id,price_id,status,period_start,period_end,cancel_at_period_end)
        values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict(stripe_subscription_id) do update set price_id=excluded.price_id,status=excluded.status,period_start=excluded.period_start,period_end=excluded.period_end,cancel_at_period_end=excluded.cancel_at_period_end,reconciled_at=now()
        where practice_billing_subscriptions.user_id=excluded.user_id and practice_billing_subscriptions.stripe_customer_id=excluded.stripe_customer_id`, [subscription.id, owner.user_id, subscription.customerId, subscription.priceId, subscription.status, iso(subscription.periodStart), iso(subscription.periodEnd), subscription.cancelAtPeriodEnd]);
      if (invoice && invoice.status !== 'paid') await client.query('update public.practice_billing_grants set revoked=true where stripe_invoice_id=$1 and user_id=$2', [invoice.id, owner.user_id]);
      if (invoice && this.eligible(invoice, subscription)) await client.query(`insert into public.practice_billing_grants(user_id,stripe_subscription_id,stripe_invoice_id,price_id,period_start,period_end,session_allowance)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict(stripe_subscription_id,period_start,period_end) do nothing`, [owner.user_id, subscription.id, invoice.id, this.configuration.priceId, iso(subscription.periodStart), iso(subscription.periodEnd), this.configuration.sessionsPerPeriod]);
      await this.finishEvent(client, event); return true;
    }, true);
  }
  private async finishEvent(client: PoolClient, event: InboxEvent, state = 'completed') {
    const updated = await client.query('update public.practice_billing_webhook_events set state=$3,completed_at=now(),lease_expires_at=null,safe_error=null where event_id=$1 and claim_token=$2 and state=\'processing\'', [event.event_id, event.claim_token, state]);
    if (updated.rowCount !== 1) throw new DomainError('conflict', 'This billing reconciliation claim is stale.');
  }
  /** Durable inbox worker; application startup and page GETs never create a Checkout/Portal session. */
  async processNextWebhook(_workerId: string): Promise<boolean> {
    void _workerId;
    const lock = await this.pool.connect(); let acquired = false;
    try {
      acquired = (await lock.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [this.configuration.advisoryLockKey + 1])).rows[0].locked;
      if (!acquired) return false;
      const event = await this.transaction(async client => {
        await client.query("update public.practice_billing_webhook_events set state='failed',safe_error='reconciliation_attempts_exhausted' where state in ('pending','processing') and attempt>=5 and (lease_expires_at is null or lease_expires_at<now())");
        const row = (await client.query<InboxEvent>("select event_id,event_type,object_id,claim_token from public.practice_billing_webhook_events where (state='pending' or (state='processing' and lease_expires_at<now())) and attempt<5 and next_attempt_at<=now() order by received_at,event_id for update skip locked limit 1")).rows[0];
        if (!row) return null;
        row.claim_token = randomUUID();
        await client.query("update public.practice_billing_webhook_events set state='processing',claim_token=$2,attempt=attempt+1,lease_expires_at=now()+interval '90 seconds' where event_id=$1", [row.event_id, row.claim_token]); return row;
      });
      if (!event) return false;
      try { return await this.reconcile(event); }
      catch {
        await this.transaction(async client => { await client.query("update public.practice_billing_webhook_events set state=case when attempt>=5 then 'failed' else 'pending' end,lease_expires_at=null,next_attempt_at=now()+make_interval(secs=>power(2,attempt)::int),safe_error='reconciliation_unavailable' where event_id=$1 and claim_token=$2 and state='processing'", [event.event_id, event.claim_token]); });
        throw safeFailure();
      }
    } catch (error) { if (error instanceof DomainError) throw error; throw safeFailure(); }
    finally { if (acquired) await lock.query('select pg_advisory_unlock($1)', [this.configuration.advisoryLockKey + 1]).catch(() => undefined); lock.release(); }
  }
}
