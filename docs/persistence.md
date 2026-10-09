# Practice persistence

`PostgresPracticeStore` is an implemented, locally tested adapter for the deterministic `SessionService`. It persists normalized rows and supports independent application and worker processes. This is qualification against a disposable PostgreSQL 16 database, not a claim about hosted Supabase deployment, production traffic, backups, or completed retention operations.

## API and deployment contract

```ts
const store = new PostgresPracticeStore(connectionStringOrPool, {
  advisoryLockKey: 843_239_117,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  maxStateBytes: 64 * 1024 * 1024,
  maxEntityRows: 100_000,
});

await store.read(); // Promise<PracticeDatabase>, consistent isolated copy
await store.transaction(database => { /* deterministic state changes only */ });
await store.close(); // ends an internally created pool, not a caller-owned pool
```

The constructor accepts `Pool | string`. The URL form creates a pool with five connections and a five-second connection timeout. The application and worker must use the same database and advisory lock key. All options are positive integers. Keep provider calls, learner execution, and other external I/O outside transaction callbacks; the service reserves a job first and a worker commits its eventual result separately.

Apply migrations in order through the project's controlled migration process:

1. `supabase/migrations/202610090001_ai_practice_foundation.sql`
2. `supabase/migrations/202610090002_runtime_persistence.sql`

The adapter does not run migrations or create auth users at startup. It expects the Supabase-compatible `auth.users`, `auth.uid()`, `anon`, `authenticated`, and `service_role` boundaries. Runtime owners must be verified UUID account IDs already present in `auth.users`. The SQL bootstrap in the test is only for a brand-new disposable database; do not apply that bootstrap to a hosted project.

`DATABASE_URL` is a private server/worker connection string for a trusted role with the required CRUD grants and RLS bypass. It is not the public Supabase API URL or anonymous key. Authentication and `SessionService` ownership checks remain mandatory because this privileged connection can read across accounts. Browser clients receive redacted DTOs and never receive this connection string or a privileged role. Authenticated SQL clients have owner-only SELECT access; INSERT, UPDATE, and DELETE are denied. Anonymous clients cannot read private practice records. Published scenario manifests are sanitized public data.

Current application selection uses PostgreSQL when `DATABASE_URL` is configured. The filesystem adapter is a local development fallback; production without PostgreSQL is rejected. A deployment still needs actual account provisioning, migration execution, network/TLS configuration, credential rotation, pooling configuration, and a database readiness check. Use provider-approved TLS validation rather than disabling certificate verification.

## What is stored

There is no whole-database blob and no whole-session aggregate row. Entity payloads preserve the typed runtime representation while relational columns provide ownership, state, foreign keys, unique constraints, and operational indexes.

| Table | Runtime purpose |
| --- | --- |
| `practice_scenario_versions` | Immutable version of the sanitized public manifest; private reference files are omitted |
| `ai_practice_sessions` | Session metadata, owner, scenario version, configuration, lifecycle, revision, frozen snapshot ID |
| `ai_practice_snapshots` | Separate immutable file snapshots, sequence, content hash, byte count |
| `ai_practice_events` | Separate immutable acknowledged events with replay sequence |
| `ai_practice_jobs` | Mutable queue state, immutable generation input, attempts, claims, lease, fence, reservation sequence |
| `ai_practice_turns` | Immutable finalized learner/interviewer turns in order |
| `ai_practice_runs` | Immutable test-run results linked to job and snapshot |
| `ai_practice_assistant_messages` | Assistant conversation entries |
| `ai_practice_edit_proposals` | Snapshot-linked proposals and explicit acceptance/rejection state |
| `ai_practice_evidence_manifests` | Immutable final evidence digest, watermark, and selected content |
| `ai_practice_reports` | Immutable coaching generations linked to frozen evidence |
| `ai_practice_requests` | Owner-scoped durable idempotency fingerprints and cached results |
| `ai_practice_usage_ledger` | Atomic admissions, reservations, settlements, and uncertain costs |
| `ai_practice_deletions` | Minimal cleanup inventory that survives session/auth cascades |

SQL composite foreign keys prevent attaching a different owner's snapshot, event, job, run, or proposal to a session. Database triggers reject updates to acknowledged snapshots, events, reports, turns, runs, and final manifests. Session deletion remains allowed through the trusted service and cascades private relational children.

Loading checks indexed identity/state fields against typed payloads, validates snapshot content hashes and manifest digests, and fails closed on missing or inconsistent payloads. Current workspace files reconstruct from the latest persisted snapshot. SQL JSON constraints bound individual entities. The adapter also limits total loaded payload text to 64 MiB and each table to 100,000 rows by default; it rejects capacity overflow rather than truncating records. These safeguards are not a validated traffic envelope.

The foundation's `ai_practice_ai_calls` and `ai_practice_artifacts` tables are not populated or reconstructed by this adapter. Current job payloads contain model/provenance and cost fields used by the service; there is no claim of complete provider billing analytics or blob lifecycle support. Private code, transcript, and report content currently remain in database rows.

## Atomicity, recovery, and limits

A write begins a SQL transaction, sets bounded statement/lock/idle timeouts, obtains one transaction advisory lock, reads current rows, runs the deterministic callback, writes only changed entity rows, and commits. Exceptions roll back changes. A separate `read()` uses a repeatable-read, read-only transaction for a consistent snapshot. Error responses suppress connection details, SQL, and private payloads.

The global lock makes revision checks, owner-scoped idempotency, quota admission, job reservation, and lease transitions atomic across processes. The same request key and fingerprint replays the committed result; a changed payload under that key is rejected. A worker claim persists a token, expiry, and monotonically increasing fence. Late output from an expired or cancelled claim cannot overwrite a replacement result. Interrupted external work may still incur a vendor charge; uncertain cost stays conservative and takeover reserves a new attempt. Application idempotency does not imply exactly-once external billing.

Finish coding freezes the code snapshot while discussion remains active. Final submit freezes the complete evidence and enqueues coaching. Failed report retries preserve generation input and evidence identity. The adapter does not call models or infer test success. Integration test outputs are synthetic fixtures used to verify persistence, not evidence of provider accuracy or learning quality.

The first adapter intentionally matches the aggregate `PracticeStore` interface. Every operation loads the bounded corpus, and all writes serialize under one lock. This is suitable for establishing correctness in a narrow initial deployment; it is not a scaling architecture. Before claiming a concurrency or latency target, measure representative corpus size, autosave frequency, queue contention, cold connections, and worker heartbeats. Evolve the service/store contract toward owner/session-scoped reads, explicit SQL commands, and carefully scoped locks while preserving quota and deletion invariants. Do not increase limits or change lock keys to conceal contention.

## Deletion, export, and retention

`exportSession` and `exportAccount` read complete private runtime content after ownership checks. Transport code must keep exports authenticated and private. This adapter does not stage export files in object storage.

`deleteSession` atomically removes the session, its private children, and cached session responses; it records a completed cleanup inventory because the current implementation stores no external blobs. Content-free quota postings remain so deleting an attempt cannot reset a daily spending or admission limit. `deleteAccount` removes sessions and owner ledger entries. Run practice cleanup before deleting the auth identity; relational auth cascades alone do not constitute a future blob or provider deletion workflow. Fenced worker output after removal is rejected.

Deletion inventory has no auth/session foreign key so cleanup can survive later cascades. It is accessible only to trusted cleanup roles. Request cache, usage, and deletion rows carry a 30-day `expires_at` value, but no expiry worker is implemented here. Those timestamps are metadata, not proof of deletion at the deadline. A retention job must respect quota windows, idempotency retry guarantees, and completed cleanup before expiring records.

Object storage, audio recordings, provider-side copies, staged exports, backups, embeddings, observability copies, and statutory retention require their own inventory and verified cleanup rules if introduced. This adapter does not promise immediate universal erasure. The file adapter's existing local data is not imported automatically. Existing hand-written SQL rows with empty `runtime_payload` are rejected; migrate or backfill them explicitly rather than fabricate missing evidence.

## Reproducing local qualification

With Docker available and the PostgreSQL image already installed locally:

```sh
RUN_POSTGRES_INTEGRATION=1 npx vitest run tests/postgres.integration.test.ts
npx vitest run tests/domain.test.ts
npx eslint lib/server/postgres-store.ts tests/postgres.integration.test.ts
npm run typecheck
```

The opt-in test creates a uniquely named disposable `postgres:16-alpine` container with `--pull=never`, a localhost ephemeral port, synthetic credentials, and no host volume. It never reads `DATABASE_URL`, connects to a hosted account, or truncates an existing database. It applies both migrations, provisions synthetic owners, runs the adapter as `service_role`, checks owner SQL access as `authenticated`, and removes its container afterward. A crashed test process may leave that uniquely named container for manual cleanup.

The ten PostgreSQL tests cover normalized round trips and cached idempotency; concurrent quota/CAS; actual RLS, anonymous denial and composite ownership constraints; rollback and immutable updates; restarted-worker fencing and uncertain cost; assistant proposal acceptance; immutable coaching retry generation; quota preservation after attempt deletion; frozen discussion/report evidence; and account erasure with cleanup records surviving auth cascades. They establish these local protocol checks only. Hosted Supabase behavior, restore drills, external cleanup, load performance, model behavior, and deployment readiness remain separate release evidence.
