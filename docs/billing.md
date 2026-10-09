# Optional practice commerce

This workstream implements a server-side Stripe adapter, signed webhook inbox and processor, normalized PostgreSQL commerce records, and atomic session allowance consumption. It reuses the shared Foundry account identity. It does not create another login system, accept card details, or move learner code into Stripe.

Billing is optional and off by default. Local qualification uses synthetic signed events and mocked Stripe resources against disposable PostgreSQL. No live Stripe customer, Checkout Session, subscription, payment, or portal was created during these tests. Hosted merchant setup, legal terms, taxes, customer support, real Stripe sandbox qualification and production readiness remain separate work.

## Configuration and integration

`billingConfigured()` returns true only with all of the following inputs:

| Input | Required behavior |
| --- | --- |
| `FEATURE_BILLING=true` | Explicit rollout gate |
| `DATABASE_URL` | Private PostgreSQL server connection; migrations applied separately |
| `STRIPE_SECRET_KEY` | Test/live secret key, kept server-side |
| `STRIPE_WEBHOOK_SECRET` | This endpoint's `whsec_` signing secret |
| `STRIPE_PRICE_ID` | One fixed recurring per-unit price |
| `STRIPE_SESSIONS_PER_PERIOD` | Explicit integer allowance, 1–500 sessions per paid billing period |
| `BILLING_FREE_SESSIONS_PER_MONTH` | Optional integer 0–20; defaults to 2 |
| `APP_URL` | Fixed trusted HTTPS origin; localhost HTTP accepted only with test keys |
| Existing Supabase URL and anonymous key | Shared verified account configuration; local cookie identities cannot use billing |

The configured flag reports configuration, not successful database or merchant qualification. Apply `202610090003_commerce.sql` after migrations 0001 and 0002. Startup never creates Stripe resources or applies schema changes. The pinned Stripe SDK is 23.0.0 and outgoing requests explicitly use `2026-09-30.endive`, matching its checked-in types. Qualify the account and webhook destination version before enabling a deployment.

Root application integration:

```ts
const store = new PostgresPracticeStore(process.env.DATABASE_URL!);
const billing = getBillingService(); // BillingService | null; no external call
const service = new SessionService(store, getScenario, {
  // Keep existing AI, concurrency, daily and monthly spending caps too.
  admissionPolicy: billing?.admissionPolicy(store),
});

// Dedicated worker iteration, alongside the practice job queue:
await getBillingService()?.processNextWebhook(workerId);
```

`getBillingService()` lives in `lib/billing/application.ts`; configuration helpers live in `lib/billing/config.ts`. A billing policy requires `PostgresPracticeStore.currentTransactionClient()`. That bridge exposes the already active transaction only to trusted server code; never retain the client after the callback. File and memory practice stores remain useful without billing. The application/worker/commerce writer must use the same practice advisory lock key, currently `843239117`.

## Learner actions and API

| Endpoint | Authentication and effect |
| --- | --- |
| `GET /api/billing` | Verified account; private status, configured allowances and remaining units; creates no Stripe objects |
| `POST /api/billing/checkout` | Verified account and same-origin POST; strict body `{requestId}`; creates/reuses the owner's hosted Checkout link |
| `POST /api/billing/portal` | Verified account and same-origin POST; strict body `{requestId}`; creates/reuses a portal link for an existing mapped customer |
| `POST /api/billing/webhook` | Stripe signature authentication over bounded exact raw bytes; durably queues verified metadata |

Checkout and portal creation must be connected to explicit UI clicks. Do not call them from rendering, page load, background polling, or worker startup. The authenticated owner, price, subscription quantity and redirects come from the server. A caller cannot choose another owner/customer, arbitrary price, success URL or return URL. Returning from Checkout is a navigation event; it does not grant access.

Stripe's [Checkout creation API](https://docs.stripe.com/api/checkout/sessions/create) supports customer mapping, subscription mode, line items and a client reference. The [portal API](https://docs.stripe.com/api/customer_portal/sessions/create) creates a hosted management session for a specified customer. Our adapter supplies the mapped customer and fixed Foundry return URL. Enable and configure the merchant's portal separately; this code does not modify merchant settings.

One explicit billing action key is cached privately. Concurrent actions for an owner serialize under a separate owner advisory lock. Existing unexpired Checkout links are reused to reduce duplicate subscriptions. Existing nonterminal subscriptions route learners to management rather than creating another subscription. Interrupted provider calls retain a pending action and retry under the same hashed Stripe key. An uncertain action older than 23 hours requires reconciliation; creating a fresh action cannot silently bypass it. Stripe documents that [API idempotency keys can be pruned after 24 hours](https://docs.stripe.com/api/idempotent_requests), so durable application state is required beyond the provider cache.

## Entitlement and usage policy

A paid grant is issued only after retrieving the current invoice and subscription. The subscription must be active, in the configured Stripe mode, have exactly one configured price at quantity one, and match the customer's mapping. The invoice must be paid, belong to that subscription/customer, originate from subscription creation or renewal, and contain a non-prorated line matching the exact current item period. Checkout completion or a browser-visible subscription label alone never grants a session. This follows Stripe's [subscription webhook guidance](https://docs.stripe.com/billing/subscriptions/webhooks), which requires checking the associated subscription before extending access.

Each subscription period can create only one allowance grant, even across duplicate event IDs or separate events referring to the same period. The allowance is frozen on that grant; changing configuration does not increase units already purchased. A monthly price grants units per month; a yearly price grants units per year. The setup must state this clearly. This first adapter supports one fixed price, no seat multiplication, trial entitlement, top-ups, proration credit, or usage-based invoice calculation. Price changes need a coordinated migration for existing renewals; saved existing grants remain usable for their original period.

On session creation the async policy runs inside the practice transaction. It selects the earliest-expiring available paid grant, then the optional UTC calendar-month free allowance. It writes one content-free commerce consumption and the deterministic service writes its existing admission ledger entry. Both commit or roll back together. Serialized transactions prevent two requests consuming the last unit. Idempotent replay returns the acknowledged session without another unit. Deleting an attempt, abandoning work or deleting all Lab contents does not refund or reset a consumption. A new request key cannot restore a used allowance.

Commerce admission limits new sessions. It does not disable saving, reading, exporting, resuming acknowledged work, or reviewing reports. The existing limits on active sessions, daily admissions, runs, AI calls, daily/monthly spending and voice remain independent controls. Buying units does not override those operational budgets. There is no automatic support refund mechanism in this workstream; that needs a separately authorized, audited policy before paid release.

Scheduled cancellation retains active access until Stripe transitions the subscription out of active status or the paid period ends. Past-due, unpaid, paused and canceled subscriptions cannot consume new paid units. Refund or dispute events conservatively block new paid access for the mapped practice customer, including partial refunds, pending support reconciliation. A delayed paid event does not clear that block. Existing work and any configured free allowance remain available. This conservative policy needs product/support review before publishing commercial terms.

## Webhook durability and ordering

The endpoint verifies the SDK signature with a five-minute timestamp tolerance using the exact raw body, then stores only event ID/type, object ID, mode, creation/receipt time and queue metadata. It rejects connected-account envelopes and mode mismatches. No raw customer, address, payment payload, email or card information is persisted in the inbox. Snapshot events are supported; configure only the listed subscription/invoice/Checkout/refund/dispute/customer event types in `lib/billing/service.ts`.

Stripe documents [raw-body verification, duplicate delivery and unordered events](https://docs.stripe.com/webhooks). Event creation timestamps have second resolution and are not used as ordering versions here. The processor serializes reconciliation, retrieves the current Stripe resources, applies changes under the practice advisory lock, and marks completion atomically. Durable claims have tokens and leases; stale claims cannot commit. Transient failure retries with exponential delay up to five attempts, then leaves an explicit failed record for operational attention. The HTTP handler returns after durable receipt, so the worker must be deployed and monitored.

Use alerts for queue age, failed events, unmapped customers, persistent pending actions and allowance inconsistencies. Operators need a reviewed reconciliation procedure for exhausted retries, refunds, interrupted customer creation and uncertain operations. This adapter supplies durable states and safe error categories, not an unrestricted admin UI or automatic financial repair tool. It deliberately does not trust webhook owner metadata to attach a Stripe customer to a Foundry identity.

## Storage, export and privacy

`practice_billing_customers`, `subscriptions`, `grants`, `consumptions` and `actions` are separate normalized tables with owner-only authenticated SELECT access and no direct client writes. Composite ownership foreign keys bind subscriptions to the owner's mapped customer. The verified event inbox is trusted-worker-only. The service-role connection can read across owners, so authenticated server ownership checks remain mandatory. Keep all credentials out of browser bundles and logs.

`BillingService.exportAccount(ownerId)` returns that owner's customer mapping, subscriptions, grants and content-free consumption. It omits reusable Checkout/Portal URLs and secret keys. Compose it into the authenticated account export. The separate practice AI usage ledger retains content-free counters to cover its quota windows; commerce consumption likewise survives Lab content deletion. These are personal operational/financial records even though they contain no learner code or transcript.

Consumption records carry `retention_deadline = period_end + 62 days`; no purge worker is implemented here. Retain enough history to enforce the original allowance window, then apply a documented expiry job. Requests, merchant mappings, grants, events, backups and provider records need a complete retention policy before rollout. Do not describe a deadline column as verified deletion.

The current account DELETE endpoint removes interview-practice content while preserving the shared identity. It does not cancel a subscription or erase commerce consumption. True auth identity deletion cascades local commerce owner rows, but must first perform the account's approved subscription/provider lifecycle; a database cascade does not cancel Stripe billing. This workstream does not implement true merchant/account erasure, cancel live subscriptions, remove legal merchant records or promise universal deletion. Review those distinctions in user-facing settings before paid release.

## Verification and remaining release evidence

```sh
npx vitest run tests/billing.test.ts tests/billing-routes.test.ts tests/domain.test.ts
RUN_POSTGRES_INTEGRATION=1 npx vitest run tests/billing.integration.test.ts
npx eslint lib/billing app/api/billing tests/billing*.ts
npm run typecheck
```

Integration tests use a new uniquely named local PostgreSQL 16 Docker container, synthetic auth users, all commerce dependencies, service-role grants, and SDK-signed fake Stripe events. They never use `DATABASE_URL`, a hosted account, live credentials, or Stripe network APIs. Actual SQL tests cover ownership/RLS, duplicate and reordered deliveries, paid eligibility, atomic quota/CAS consumption and rollback, safe retries, free allowance, deletion without reset, refund blocking, retry backoff, current-state reconciliation, and private export. Unit/route tests cover configuration gates, raw signature tampering/staleness, explicit same-origin actions and server-controlled price/ownership.

Before a paid beta, qualify real Stripe sandbox Checkout, portal configuration, invoice lifecycle, retry/redelivery, cancellation and refunds; publish pricing/allowance terms; verify deployment/migrations and shared account integration; deploy queue monitoring and reconciliation; implement approved retention/erasure; and perform expected-traffic load testing. No live merchant mutation or spending is authorized by the local tests.
