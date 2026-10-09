import type { BillingStatus } from '@/lib/billing/service';

export function parseBillingStatus(value: unknown): BillingStatus | { enabled: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Your practice allowance could not be loaded.');
  const status = value as Record<string, unknown>;
  if (status.enabled === false) return { enabled: false };
  const counts = ['freeSessionsPerMonth', 'sessionsPerPaidPeriod', 'remaining', 'paidRemaining', 'freeRemaining'];
  if (status.enabled !== true || counts.some(key => !Number.isSafeInteger(status[key]) || (status[key] as number) < 0) ||
      typeof status.blocked !== 'boolean' || typeof status.hasCustomer !== 'boolean' ||
      typeof status.subscriptionStatus !== 'string' || !/^[a-z_]{1,40}$/.test(status.subscriptionStatus) ||
      (status.periodEnd !== null && (typeof status.periodEnd !== 'string' || !Number.isFinite(Date.parse(status.periodEnd)))) ||
      status.remaining !== (status.freeRemaining as number) + (status.paidRemaining as number)) throw new Error('Your practice allowance could not be loaded. Refresh or try again later.');
  return status as BillingStatus;
}

export function stripeDestination(value: unknown, action: 'checkout' | 'portal'): string {
  if (typeof value !== 'string') throw new Error('A secure billing link was not available. Try the same action again.');
  let destination: URL;
  try { destination = new URL(value); } catch { throw new Error('A secure billing link was not available.'); }
  const host = action === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com';
  if (destination.protocol !== 'https:' || destination.hostname !== host || destination.port || destination.username || destination.password) throw new Error('The billing link was not a supported secure Stripe destination.');
  return destination.href;
}
