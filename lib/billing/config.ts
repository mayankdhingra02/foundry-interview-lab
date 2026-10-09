export type BillingConfiguration = { secretKey: string; webhookSecret: string; priceId: string; databaseUrl: string; origin: string; sessionsPerPeriod: number; freeSessionsPerMonth: number; livemode: boolean; advisoryLockKey: number };
/** Configuration is deliberately all-or-nothing. This does not verify a merchant account or price. */
export function billingConfiguration(env: Record<string, string | undefined> = process.env): BillingConfiguration | null {
  if (env.FEATURE_BILLING !== 'true' || !/^sk_(test|live)_\S+$/.test(env.STRIPE_SECRET_KEY || '') || !/^whsec_\S+$/.test(env.STRIPE_WEBHOOK_SECRET || '') || !/^price_[\w]+$/.test(env.STRIPE_PRICE_ID || '') || !env.DATABASE_URL || !env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.AUTH_MODE === 'local') return null;
  const allowance = Number(env.STRIPE_SESSIONS_PER_PERIOD), free = Number(env.BILLING_FREE_SESSIONS_PER_MONTH ?? 2);
  if (!Number.isSafeInteger(allowance) || allowance < 1 || allowance > 500 || !Number.isSafeInteger(free) || free < 0 || free > 20) return null;
  try {
    const origin = new URL(env.APP_URL || ''), database = new URL(env.DATABASE_URL);
    const livemode = env.STRIPE_SECRET_KEY!.startsWith('sk_live_');
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && !livemode && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) return null;
    return { secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET!, priceId: env.STRIPE_PRICE_ID!, databaseUrl: env.DATABASE_URL, origin: origin.origin, sessionsPerPeriod: allowance, freeSessionsPerMonth: free, livemode, advisoryLockKey: 843_239_117 };
  } catch { return null; }
}
export const billingConfigured = (env: Record<string, string | undefined> = process.env) => billingConfiguration(env) !== null;
