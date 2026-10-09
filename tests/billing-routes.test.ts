import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/server/http';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), get: vi.fn(), status: vi.fn(), checkout: vi.fn(), portal: vi.fn(), webhook: vi.fn() }));
vi.mock('../lib/server/auth', () => ({ requireActor: mocks.actor }));
vi.mock('../lib/billing/application', () => ({ getBillingService: mocks.get }));
import { billingAction, billingStatus, billingWebhook } from '../lib/billing/routes';

const owner = '73efbd73-729b-4b58-80ab-8c67240ef3db';
const request = (body: unknown = { requestId: 'explicit-request-key' }, origin = 'https://foundry.example') => new Request('https://foundry.example/api/billing/checkout', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
describe('explicit billing HTTP triggers and webhook transport', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv('APP_URL', 'https://foundry.example');
    mocks.actor.mockResolvedValue({ id: owner, local: false });
    mocks.get.mockReturnValue({ status: mocks.status, checkout: mocks.checkout, portal: mocks.portal, receiveWebhook: mocks.webhook });
    mocks.status.mockResolvedValue({ enabled: true, remaining: 2 });
    mocks.checkout.mockResolvedValue({ url: 'https://checkout.stripe.com/synthetic' }); mocks.portal.mockResolvedValue({ url: 'https://billing.stripe.com/synthetic' }); mocks.webhook.mockResolvedValue({ received: true });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('does not create a checkout or portal while reading status', async () => {
    const response = await billingStatus(new Request('https://foundry.example/api/billing'));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.checkout).not.toHaveBeenCalled(); expect(mocks.portal).not.toHaveBeenCalled();
  });
  it('derives the owner from authentication and creates links only for explicit same-origin POST', async () => {
    expect((await billingAction(request(), 'checkout')).status).toBe(200);
    expect(mocks.checkout).toHaveBeenCalledWith(owner, 'explicit-request-key');
    expect((await billingAction(request(), 'portal')).status).toBe(200);
    expect(mocks.portal).toHaveBeenCalledWith(owner, 'explicit-request-key');
    expect((await billingAction(request({}, 'https://evil.example'), 'checkout')).status).toBe(403);
    expect(mocks.checkout).toHaveBeenCalledTimes(1);
  });
  it('rejects caller-supplied owner, price and redirect fields', async () => {
    const response = await billingAction(request({ requestId: 'explicit-request-key', ownerId: 'other', priceId: 'price_other', successUrl: 'https://evil.example' }), 'checkout');
    expect(response.status).toBe(400); expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('rejects local and unsigned identities before any billing operation', async () => {
    mocks.actor.mockResolvedValue({ id: owner, local: true }); expect((await billingAction(request(), 'checkout')).status).toBe(403);
    mocks.actor.mockRejectedValue(new HttpError(401, 'authentication_required', 'Sign in.')); expect((await billingAction(request(), 'checkout')).status).toBe(401);
    expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('keeps unconfigured billing disabled and blocks mutations', async () => {
    mocks.get.mockReturnValue(null);
    expect(await (await billingStatus(new Request('https://foundry.example/api/billing'))).json()).toEqual({ enabled: false });
    expect((await billingAction(request(), 'checkout')).status).toBe(503); expect(mocks.checkout).not.toHaveBeenCalled();
  });
  it('passes exact raw webhook bytes and signature without browser Origin or account authentication', async () => {
    const body = ' {"synthetic": true}\n';
    const response = await billingWebhook(new Request('https://foundry.example/api/billing/webhook', { method: 'POST', headers: { 'stripe-signature': 'synthetic-signature' }, body }));
    expect(response.status).toBe(200); expect(mocks.webhook).toHaveBeenCalledWith(Buffer.from(body), 'synthetic-signature'); expect(mocks.actor).not.toHaveBeenCalled();
  });
  it('rejects missing signatures and oversized raw webhook streams', async () => {
    expect((await billingWebhook(new Request('https://foundry.example/api/billing/webhook', { method: 'POST', body: '{}' }))).status).toBe(400);
    expect((await billingWebhook(new Request('https://foundry.example/api/billing/webhook', { method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: 'x'.repeat(256_001) }))).status).toBe(413);
    expect(mocks.webhook).not.toHaveBeenCalled();
  });
});
