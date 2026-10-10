import { describe, expect, it, vi } from 'vitest';
import { billingConfiguration, billingConfigured } from '../lib/billing/config';
import { StripeBillingGateway } from '../lib/billing/stripe';
import { billingConfig, FakeBillingGateway, signedEvent } from './billing-fixtures';

const configured = { FEATURE_BILLING: 'true', STRIPE_SECRET_KEY: 'sk_test_synthetic_only', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic_only', STRIPE_PRICE_ID: 'price_foundry', STRIPE_SESSIONS_PER_PERIOD: '5', DATABASE_URL: 'postgres://localhost/foundry', APP_URL: 'http://127.0.0.1:3000', NEXT_PUBLIC_SUPABASE_URL: 'https://synthetic.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic' };
describe('optional commerce configuration and Stripe signature boundary', () => {
  it('stays disabled until every required deployment input is supplied', () => {
    expect(billingConfigured({})).toBe(false); expect(billingConfigured(configured)).toBe(true);
    for (const key of Object.keys(configured)) expect(billingConfigured({ ...configured, [key]: '' })).toBe(false);
    expect(billingConfigured({ ...configured, FEATURE_BILLING: 'false' })).toBe(false);
    expect(billingConfigured({ ...configured, AUTH_MODE: 'local' })).toBe(false);
    expect(billingConfigured({ ...configured, STRIPE_SESSIONS_PER_PERIOD: '1.5' })).toBe(false);
    expect(billingConfigured({ ...configured, BILLING_FREE_SESSIONS_PER_MONTH: '-1' })).toBe(false);
    expect(billingConfigured({ ...configured, STRIPE_SECRET_KEY: 'sk_live_synthetic' })).toBe(false);
    expect(billingConfiguration(configured)?.freeSessionsPerMonth).toBe(2);
  });
  it('verifies actual Stripe SDK signatures on exact raw bytes and rejects tampering/stale timestamps', () => {
    const gateway = new FakeBillingGateway(), event = signedEvent(gateway, 'evt_signature');
    expect(gateway.verify(event.payload, event.signature).id).toBe('evt_signature');
    expect(() => gateway.verify(Buffer.concat([event.payload, Buffer.from(' ')]), event.signature)).toThrow('signature');
    const old = gateway.verifier.stripe.webhooks.generateTestHeaderString({ payload: event.payload.toString(), secret: billingConfig.webhookSecret, timestamp: Math.floor(Date.now() / 1000) - 600 });
    expect(() => gateway.verify(event.payload, old)).toThrow('signature');
  });
  it('creates checkout with server-controlled owner/price/redirects and stable retry parameters', async () => {
    const gateway = new StripeBillingGateway(billingConfig);
    const create = vi.spyOn(gateway.stripe.checkout.sessions, 'create');
    create.mockResolvedValue({ id: 'cs_test_fixture', url: 'https://checkout.stripe.com/synthetic', expires_at: 123, livemode: false } as unknown as Awaited<ReturnType<typeof create>>);
    await gateway.createCheckout('owner', 'cus_foundry', 'hashed-key'); await gateway.createCheckout('owner', 'cus_foundry', 'hashed-key');
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0][0]).toMatchObject({ customer: 'cus_foundry', client_reference_id: 'owner', mode: 'subscription', line_items: [{ price: billingConfig.priceId, quantity: 1 }], success_url: `${billingConfig.origin}/settings?billing=returned` });
    expect(create.mock.calls[0][0]).not.toHaveProperty('expires_at');
  });
});
