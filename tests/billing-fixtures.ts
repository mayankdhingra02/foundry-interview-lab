import type Stripe from 'stripe';
import type { Scenario } from '../lib/interview-practice/types';
import type { BillingConfiguration } from '../lib/billing/config';
import { StripeBillingGateway, type BillingGateway, type BillingInvoice, type BillingSubscription } from '../lib/billing/stripe';

export const billingConfig: BillingConfiguration = { secretKey: 'sk_test_synthetic_only', webhookSecret: 'whsec_synthetic_only', priceId: 'price_foundry', databaseUrl: 'postgres://synthetic', origin: 'https://foundry.example', sessionsPerPeriod: 2, freeSessionsPerMonth: 0, livemode: false, advisoryLockKey: 843_239_117 };
export const billingScenario: Scenario = { id: 'billing-fixture', version: '1', title: 'Synthetic commerce test', summary: 'Billing fixture', durationMinutes: 30, level: 'mid', tags: ['testing'], language: 'python', files: { 'main.py': 'pass\n' }, stages: [{ id: 'debug', title: 'Work', brief: 'Inspect', requirements: ['Inspect code'] }, { id: 'debrief', title: 'Explain', brief: 'Explain', requirements: ['Explain tests'] }], rubric: [{ id: 'testing', name: 'Tests', description: 'Test behavior', anchors: { strong: 'Verified', developing: 'Partial', needsWork: 'Missing' } }], probes: [{ id: 'probe', stageId: 'debrief', competencyId: 'testing', question: 'What did you verify?' }], hints: [], tests: [{ id: 'smoke', title: 'Smoke', source: 'assert True', visible: true, timeoutSeconds: 1 }], referenceFiles: { 'main.py': 'pass\n' }, drills: [{ id: 'drill', title: 'Test', competencyId: 'testing', lesson: 'Test', exercise: 'Test an example' }], rights: 'Original synthetic fixture', runtime: { image: 'python:3.11-slim', timeoutSeconds: 2, memoryMb: 128 } };
export class FakeBillingGateway implements BillingGateway {
  readonly verifier = new StripeBillingGateway(billingConfig);
  calls = { customer: 0, checkout: 0, portal: 0, price: 0, subscription: 0, invoice: 0 };
  failCheckout = false;
  checkoutKeys: string[] = [];
  subscriptions = new Map<string, BillingSubscription>();
  invoices = new Map<string, BillingInvoice>();
  risk = { customerId: 'cus_foundryA', blocked: true };
  verify(payload: Buffer, signature: string): Stripe.Event { return this.verifier.verify(payload, signature); }
  async validatePrice() { this.calls.price++; }
  async createCustomer() { this.calls.customer++; return 'cus_foundryA'; }
  async createCheckout(_owner: string, _customer: string, key: string) {
    this.calls.checkout++; this.checkoutKeys.push(key); if (this.failCheckout) throw new Error('Synthetic transport interruption');
    return { id: 'cs_test_foundry', url: 'https://checkout.stripe.com/c/pay/synthetic', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
  }
  async createPortal() { this.calls.portal++; return { id: 'bps_foundry', url: 'https://billing.stripe.com/p/session/synthetic' }; }
  async subscription(id: string) { this.calls.subscription++; const value = this.subscriptions.get(id); if (!value) throw new Error('Missing synthetic subscription'); return structuredClone(value); }
  async invoice(id: string) { this.calls.invoice++; const value = this.invoices.get(id); if (!value) throw new Error('Missing synthetic invoice'); return structuredClone(value); }
  async checkoutSubscription() { return 'sub_foundry'; }
  async riskCustomer() { return this.risk; }
}
export function paidFixture(gateway: FakeBillingGateway) {
  const start = Math.floor(Date.now() / 1000) - 60, end = start + 30 * 86_400;
  gateway.subscriptions.set('sub_foundry', { id: 'sub_foundry', customerId: 'cus_foundryA', status: 'active', priceId: billingConfig.priceId, quantity: 1, periodStart: start, periodEnd: end, latestInvoiceId: 'in_foundry', cancelAtPeriodEnd: false, livemode: false });
  gateway.invoices.set('in_foundry', { id: 'in_foundry', customerId: 'cus_foundryA', subscriptionId: 'sub_foundry', status: 'paid', reason: 'subscription_create', amountPaid: 3000, livemode: false, lines: [{ priceId: billingConfig.priceId, quantity: 1, start, end, proration: false }] });
}
export function signedEvent(gateway: FakeBillingGateway, id: string, type = 'invoice.paid', objectId = 'in_foundry', extra: Record<string, unknown> = {}) {
  const event = { id, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: objectId, email: 'DO-NOT-PERSIST@example.com', metadata: { owner: 'UNTRUSTED-MAPPING' } } }, ...extra };
  const payload = JSON.stringify(event), signature = gateway.verifier.stripe.webhooks.generateTestHeaderString({ payload, secret: billingConfig.webhookSecret });
  return { payload: Buffer.from(payload), signature };
}
