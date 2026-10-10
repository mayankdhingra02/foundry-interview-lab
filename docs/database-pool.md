# Practice/readiness database composition

The standalone application injects one lazily constructed pool into `PostgresPracticeStore` and the operational readiness, admission and heartbeat functions. These paths previously constructed separate pools with maxima of five and two. They now share a default maximum of **five connections per composition/process**. Creating the pool does not connect, apply migrations, provision accounts or enable a feature.

`PRACTICE_DATABASE_POOL_MAX` accepts exactly one decimal digit from `1` to `5`; unset means `5`. Empty, whitespace, fractional and out-of-range values fail closed before pool construction. The first pool's database URL and maximum remain pinned until process shutdown. Changing environment variables does not redirect an existing service to another database.

The shared pool uses the practice path's existing five-second connection-acquisition timeout. Readiness and standalone operational queries retain a two-second PostgreSQL statement timeout and ten-second idle-client timeout. An operation waiting for a busy shared pool can therefore wait up to five seconds for acquisition before its SQL timeout applies; it no longer has an independent two-second-acquisition operations pool. Practice transactions still install their existing transaction-local statement/idle timeout of fifteen seconds and lock timeout of five seconds. Commit or rollback restores the pool's operational statement timeout. These are timeout bounds, not a measured latency guarantee or a bounded count of waiting requests.

Invalid pool configuration or shutdown returns a public-safe `not_ready` response and denies execution admission. Readiness still checks the required schema, writer privileges and fresh worker heartbeat, including when execution is disabled. Pool sharing does not relax those checks or establish deployment readiness.

## Explicit composition for a constrained host

An integrating server can create one bounded owner and lend the same pool to its store and readiness probe:

```ts
const database = createPracticeDatabasePool({ connectionString, max: 1 });
const store = new PostgresPracticeStore(database.pool);
const health = await probeReadiness(database.pool, {
  configurationReady: verifiedHostConfiguration,
  executionRequired: false,
});
// After requests, jobs and any heartbeat have drained:
await database.close();
```

`createPracticeDatabasePool`, `PostgresPracticeStore` and `probeReadiness` are server-side imports from `lib/server/database-pool.ts`, `postgres-store.ts` and `operations.ts`. The host remains responsible for its verified account boundary, required-feature readiness options, TLS validation, schema/privileges, worker lifecycle and admission policy. This example is a composition primitive; it does not wire or authorize Engineering Foundry runtime access. A restricted role or unapplied schema continues to fail readiness. Do not disable certificate verification to make a connection succeed.

An explicit composition owns its pool. A store receiving a `Pool` borrows it: `store.close()` does not end that pool. An explicit owner's `close()` calls `Pool.end()` once and returns the same completion promise to concurrent callers, including a rejected close. The existing string form `new PostgresPracticeStore(url)` is unchanged: it owns a separate max-five pool with a five-second acquisition timeout and closes that pool itself. Existing standalone maintenance scripts using that form retain their behavior.

## Shutdown and limits

The default composition exposes `closePracticeDatabasePool()` for its owner. It is terminal and idempotent: no new default pool can be obtained while or after shutdown, and a failed close does not silently create a replacement behind a cached service. Drain existing users first; do not reuse a cached service after closing its pool. The standalone worker keeps its existing signal behavior, finishing current work before stopping the heartbeat and awaiting the shared pool's close. Cleanup also runs when service/heartbeat startup or final heartbeat shutdown fails. Web hosts must drain their own requests before invoking shutdown; this patch does not install extra Next.js signal handlers.

The limit applies to each explicit composition, not to an entire deployment. Separate web/worker processes, replicas, independently constructed pools and billing can add connections. **Billing retains its separate existing pool and is outside this change.** For a future zero-additional-cost Foundry bridge, billing and paid AI/execution remain off; a `max: 1` application setting alone does not satisfy a global three-connection database-role ceiling under autoscaling. Platform concurrency/replicas and the database role's hard limit need separate review. This patch performs no Engineering Foundry integration or database migration.

## Evidence and remaining qualification

Fake-transport unit tests exercise the actual standalone service/readiness composition, default and explicit max-one bounds, malformed configuration, pinned configuration, operational admission/heartbeats, transaction-local timeouts, borrowed versus owned closure, terminal concurrent shutdown and content-free idle-error logging. Worker lifecycle tests cover current-job drain and cleanup after startup/final-heartbeat failures. They make no database, Docker or provider calls. These tests verify composition and control flow; actual TLS, pooler behavior, cross-process connection ceilings and hosted readiness remain deployment qualification work.
