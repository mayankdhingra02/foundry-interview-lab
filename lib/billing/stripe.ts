import Stripe from 'stripe';
import { DomainError } from '../interview-practice/domain';
import type { BillingConfiguration } from './config';

export type BillingSubscription = { id: string; customerId: string; status: string; priceId: string | null; quantity: number; periodStart: number; periodEnd: number; latestInvoiceId: string | null; cancelAtPeriodEnd: boolean; livemode: boolean };
export type BillingInvoice = { id: string; customerId: string; subscriptionId: string | null; status: string | null; reason: string | null; amountPaid: number; livemode: boolean; lines: { priceId: string | null; quantity: number; start: number; end: number; proration: boolean }[] };
export type CheckoutLink = { id: string; url: string; expiresAt: number };
export interface BillingGateway {
  verify(payload: Buffer, signature: string): Stripe.Event;
  validatePrice(): Promise<void>;
  createCustomer(ownerId: string, key: string): Promise<string>;
  createCheckout(ownerId: string, customerId: string, key: string): Promise<CheckoutLink>;
  createPortal(customerId: string, key: string): Promise<{ id: string; url: string }>;
  subscription(id: string): Promise<BillingSubscription>;
  invoice(id: string): Promise<BillingInvoice>;
  checkoutSubscription(id: string): Promise<string | null>;
  riskCustomer(type: string, id: string): Promise<{ customerId: string | null; blocked: boolean }>;
}
const objectId = (value: string | { id: string } | null | undefined) => typeof value === 'string' ? value : value?.id ?? null;
const failure = () => new DomainError('unavailable', 'Billing could not be reconciled. Retry safely or contact support.');
export class StripeBillingGateway implements BillingGateway {
  readonly stripe: Stripe;
  constructor(private readonly configuration: BillingConfiguration) {
    // SDK 23.0.0 schema; qualify this version and the webhook destination together before rollout.
    this.stripe = new Stripe(configuration.secretKey, { apiVersion: '2026-09-30.endive', timeout: 10_000, maxNetworkRetries: 1 });
  }
  verify(payload: Buffer, signature: string) {
    try { return this.stripe.webhooks.constructEvent(payload, signature, this.configuration.webhookSecret, 300); }
    catch { throw new DomainError('invalid', 'The billing webhook signature is invalid.'); }
  }
  async validatePrice() {
    const price = await this.stripe.prices.retrieve(this.configuration.priceId);
    if (!price.active || price.livemode !== this.configuration.livemode || !price.recurring || !['month', 'year'].includes(price.recurring.interval) || price.recurring.interval_count !== 1 || price.recurring.usage_type !== 'licensed' || price.billing_scheme !== 'per_unit') throw failure();
  }
  async createCustomer(ownerId: string, key: string) {
    const customer = await this.stripe.customers.create({ metadata: { foundry_practice_owner: ownerId } }, { idempotencyKey: key });
    if (customer.livemode !== this.configuration.livemode) throw failure(); return customer.id;
  }
  async createCheckout(ownerId: string, customerId: string, key: string): Promise<CheckoutLink> {
    const session = await this.stripe.checkout.sessions.create({ mode: 'subscription', customer: customerId, client_reference_id: ownerId, line_items: [{ price: this.configuration.priceId, quantity: 1 }], subscription_data: { metadata: { foundry_practice_owner: ownerId } }, metadata: { foundry_practice_owner: ownerId }, success_url: `${this.configuration.origin}/settings?billing=returned`, cancel_url: `${this.configuration.origin}/settings?billing=cancelled` }, { idempotencyKey: key });
    if (!session.url || session.livemode !== this.configuration.livemode) throw failure();
    return { id: session.id, url: session.url, expiresAt: session.expires_at };
  }
  async createPortal(customerId: string, key: string) {
    const portal = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${this.configuration.origin}/settings` }, { idempotencyKey: key });
    return { id: portal.id, url: portal.url };
  }
  async subscription(id: string): Promise<BillingSubscription> {
    const subscription = await this.stripe.subscriptions.retrieve(id), items = subscription.items.data;
    const item = items[0];
    return { id: subscription.id, customerId: objectId(subscription.customer)!, status: subscription.status, priceId: items.length === 1 ? item?.price.id ?? null : null, quantity: item?.quantity ?? 0, periodStart: item?.current_period_start ?? 0, periodEnd: item?.current_period_end ?? 0, latestInvoiceId: objectId(subscription.latest_invoice), cancelAtPeriodEnd: subscription.cancel_at_period_end, livemode: subscription.livemode };
  }
  async invoice(id: string): Promise<BillingInvoice> {
    const invoice = await this.stripe.invoices.retrieve(id), lines = await this.stripe.invoices.listLineItems(id, { limit: 100 });
    if (lines.has_more) throw failure();
    return { id: invoice.id, customerId: objectId(invoice.customer)!, subscriptionId: objectId(invoice.parent?.subscription_details?.subscription), status: invoice.status, reason: invoice.billing_reason, amountPaid: invoice.amount_paid, livemode: invoice.livemode, lines: lines.data.map(line => ({ priceId: objectId(line.pricing?.price_details?.price), quantity: line.quantity ?? 0, start: line.period.start, end: line.period.end, proration: line.parent?.subscription_item_details?.proration ?? line.parent?.invoice_item_details?.proration ?? false })) };
  }
  async checkoutSubscription(id: string) { const checkout = await this.stripe.checkout.sessions.retrieve(id); return objectId(checkout.subscription); }
  async riskCustomer(type: string, id: string) {
    if (type === 'customer.deleted') return { customerId: id, blocked: true };
    const chargeId = type.startsWith('charge.dispute.') ? objectId((await this.stripe.disputes.retrieve(id)).charge) : id;
    if (!chargeId) throw failure();
    const charge = await this.stripe.charges.retrieve(chargeId);
    return { customerId: objectId(charge.customer), blocked: charge.refunded || charge.amount_refunded > 0 || charge.disputed };
  }
}
