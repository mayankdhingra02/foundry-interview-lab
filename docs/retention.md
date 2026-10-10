# Operational data retention

`lib/server/retention.ts` implements a manual maintenance operation for redundant request caches, settled usage ledger rows, and completed deletion metadata. Saved attempts, code snapshots, transcripts, test observations, evidence manifests, coaching reports, corrections, and support records are preserved. Learner deletion uses the separate deletion workflow. Raw audio and synthesized audio are never persisted by the application; this command does not introduce audio storage.

This is a deterministic operation over the configured `PracticeStore`. It does not initialize billing, AI, speech, or sandbox providers. It does not change a subscription, refund a charge, invoke a model, or delete upstream provider data.

## Policy and expiry boundaries

The accepted policy is exported as `RETENTION_POLICY`, version `operational-retention-v1`.

| Data | Earliest eligibility | Additional conditions |
| --- | --- | --- |
| Request idempotency cache | `createdAt <= now - 30 days` | Trusted completed or deleted attempt; no active obligation; see cache rules below. |
| Usage ledger | Every member's actual `createdAt <= now - 62 days` | Complete, unambiguous settlement group; no uncertain commitment or current budget attribution. |
| Deletion metadata | Both `createdAt` and `completedAt <= now - 30 days` | Completed cleanup, empty object inventory, no saved session or remaining dependent cache. |
| Canonical saved attempt and immutable evidence | No expiry in this operation | Remain until learner deletion. |
| Support cases, drafts, decisions, publications and audits | No expiry in this operation | Separate support retention policy and access controls apply. |

Days mean exact 24-hour UTC durations. Equality at the cutoff is eligible; a row one millisecond younger remains. The additional 30 days after deletion completion is intentionally conservative: old creation metadata cannot expire while cleanup is recent or unfinished.

PostgreSQL migrations and persistence currently write `expires_at` metadata using the same 30/62-day durations. Those columns are not loaded into `PracticeDatabase`; the maintenance policy therefore derives cutoffs from validated runtime timestamps. It does not issue a broad `DELETE WHERE expires_at < now()` or assume that hand-edited SQL expiry metadata is authoritative. Changing the policy requires a reviewed code change and policy version update. Existing expiry columns by themselves do not delete data.

## Request caches and replay

A request cache can contain a full copy of a session response, including copied learner content. Expiring that redundant copy is desirable after its retention period; the canonical saved attempt remains unchanged.

A trusted session link may come from `record.sessionId`, `record.result.session.id` (including create responses), or `record.result.sessionId`. Every present link must agree. The cache owner must match the saved session owner. A saved session must be completed with a persisted report before its cache can expire. A missing session requires a matching, completed deletion record with an empty object inventory. Unlinked `{ "deleted": true }` acknowledgments can expire when their owner has no active obligation. Other unlinked legacy responses are preserved for investigation.

The operation preserves caches for active, paused, or reviewing sessions, completed sessions with queued/running jobs, and sessions with open or triaged support cases. Pending cleanup also protects its session. This includes original create responses, which often lack `record.sessionId`: inferring `result.session.id` prevents expiry from turning an acknowledged active creation retry into a second attempt.

The replay guarantee for an otherwise eligible terminal/deleted cache ends after 30 days. After expiry, a very old creation key can be treated as a new request; callers must use a new key for a new attempt. Active creation caches remain protected beyond 30 days. Inconsistent links, owner mismatch, invalid timestamps, and ambiguous legacy results are retained instead of guessed.

An expired deletion tombstone stays while any unselected request response still refers to that owner/session. A small batch may remove a response first and its tombstone in the next run; the reverse order is forbidden. Recent response copies can therefore extend their tombstone's retention.

## Quota and ledger protection

Ledger grouping uses the same `ledgerBudgetGroupKey` helper as budget accounting. Its identity contains the owner, session, and complete operation prefix, including AI retry reservation sequence. It cannot merge different owners, sessions, or retries.

An ordinary removable group has exactly one nonnegative reservation and one settlement, with distinct unique IDs. Both actual posting times must be at least 62 days old. An admission row is removable only as a single old zero-dollar row. A group is indivisible: a row budget smaller than a two-row settlement group removes neither member.

The operation preserves:

- Pending reservations, uncertain postings, orphan settlements, duplicate reservations/settlements/IDs, and malformed ledger records.
- An old reservation whose settlement was posted recently. A late posting never causes the original reservation to disappear first.
- Any group with a recent `budgetAt`. Reservation metadata must identify its original creation instant; terminal metadata, when present, must agree. Legacy groups without `budgetAt` use the same exact association as quota accounting.
- Ledger associated with protected active work or support obligations.
- Old voice allocations for a saved legacy session that lacks `usage.voiceAllocatedSeconds`. These rows still supply its cumulative session allowance. A durable cumulative counter allows eventual safe expiry; this command does not invent or backfill one.

Deleting an old attempt or its cleanup metadata does not erase current ledger entries. Current user daily/monthly USD totals, global daily USD totals, and daily admission counts retain their inputs. Saved session usage summaries are untouched. Ambiguous financial commitments require operator investigation; retention does not release them merely because they are old. This ledger is operational usage accounting, not the separate commerce/payment audit record.

Deletion of a queued AI job can release its untouched reservation with a zero-cost settlement; that complete group can expire after both postings reach 62 days. Deletion of running positive-cost work records uncertainty, so its commitment remains retained. In-flight voice work stays reserved until a valid settlement callback or the separate [voice reconciliation](voice-reconciliation.md) path marks an expired reservation uncertain. That transition releases concurrency, retains cost/minutes and original budget attribution, and never invents a successful provider outcome or a refund for deleted work. Uncertain groups remain ineligible for ordinary retention.

## API and bounded execution

```ts
runRetention(store: PracticeStore, {
  apply?: boolean,       // default false
  maxRows?: number,      // default 100; integer 1..1000
  now?: Date,            // test injection; CLI always uses current clock
}): Promise<RetentionResult>
```

Dry-run calls `store.read()` and never opens a write transaction. For a missing local store, it does not create a directory or file. Apply computes eligibility again inside the existing store transaction lock and only then mutates the three operational collections. It does not reuse a prior dry-run selection. PostgreSQL uses the adapter's transaction/advisory lock; the local file adapter uses its existing exclusive lock and atomic file replacement. A planning error causes no partial removal.

One apply removes at most `maxRows` across all three collections. Requests are selected first, whole ledger groups second, deletion metadata last. `moreEligible` means at least one otherwise eligible unit did not fit. Increase `maxRows` above one to remove a reservation/settlement pair. Counts can change between dry-run and apply because eligibility is rechecked under the lock.

The planner rejects more than 100,000 aggregate rows across operational tables, sessions/jobs, and support entities. This bounds its scan work, not just removals. The current PostgreSQL adapter still loads its aggregate runtime state before the planner runs, subject to the adapter's own row/byte limits and database timeouts. This is a maintenance path for the current implementation; it is not a demonstrated large-scale paginated SQL sweeper. At the safety bound, stop and implement a qualified database-side strategy rather than raising the limit without measurement.

Output contains policy version, mode, clock/cutoffs, batch limit, aggregate examined/eligible/selected/removed counts, retention-reason counts, and `moreEligible`. No owner/session IDs, request IDs, ledger operation IDs, learner contents, object keys, credentials, or connection strings are returned or logged. Errors use fixed categories. The command does not emit the underlying storage/provider error text.

## Operator recipe

Use the same configured Node runtime and server environment as the application. From the repository, with private `.env.local` configuration:

```sh
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/retention.ts --dry-run --max-rows 100
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/retention.ts --apply --max-rows 100
```

Omitting `--dry-run` is still dry-run. Mutation requires `--apply`; conflicting mode flags and invalid sizes fail. `--help` does not initialize storage. `DATABASE_URL` selects PostgreSQL directly and the command closes its pool on completion. Production refuses to fall back to file storage when `DATABASE_URL` is missing. Local file mode uses the directory of `PRACTICE_DATA_PATH` and the adapter's canonical `practice.json` filename; set that variable to the intended `.../practice.json` path.

Before the first apply, verify the target environment without printing its connection string, check the approved backup/restore procedure, and review the count-only dry-run. Start with a small batch, then repeat dry-run/apply while `moreEligible` is true and database latency is acceptable. Do not create overlapping scheduled runs; existing locking serializes them, but duplicate work adds load. No automatic schedule is installed by this change.

Exit code 0 confirms that run completed, including a successful dry-run or no-op. Exit code 1 requires investigation. `invalid_options` means argument validation failed; `scan_limit` means the bounded aggregate scan was exceeded; `storage_or_policy_unavailable` covers safe storage/policy failures. Do not retry with a broad SQL delete, disable the store lock, remove uncertain reservations, or log runtime payloads. If an apply result is uncertain because the process lost its connection, run a fresh dry-run; removed eligible rows stay removed and a repeated apply is idempotent.

There is no undo from the count-only output. Recovery from an erroneous policy/application change uses the approved database/file backup workflow in an isolated environment first, preserving more recent learner writes and immutable support history during reconciliation. This command does not expire backups, object-storage retention policies, payment-provider records, or provider-side logs; their separate operational policies remain required.

## Qualification status

Automated tests cover exact cutoffs, true dry-run behavior, file bytes/mtime, replanning under the lock, bounded whole-group deletion, repeated apply, canonical evidence/support preservation, active create-cache protection, terminal copied-response expiry, cleanup dependencies, legacy and uncertain quota records, durable voice-counter protection, and unchanged current budget/admission totals. The CLI is exercised against disposable synthetic local storage with no provider configuration.

`tests/retention-postgres.integration.test.ts` provides three opt-in real-SQL cases: service-role delete synchronization with canonical evidence and active replay preserved, bounded cache/tombstone/ledger deletion across independent adapters, and open-support protection. Enable only in an authorized disposable Docker environment with cached/provisioned `postgres:16-alpine`, using `RUN_POSTGRES_INTEGRATION=1 npm test -- tests/retention-postgres.integration.test.ts`. It never reads `DATABASE_URL`. These three cases passed in [run 37992285344](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/37992285344), alongside 36 other PostgreSQL cases, and passed again in runtime qualification run 37995581500. They remain unexecuted locally under the current no-Docker constraint. The earlier retention run missed its operational p95 gate; the SQL pass is not a hosted retention or capacity qualification.

Hosted PostgreSQL dry-run/apply, database privilege review, production-like contention/latency, backup restoration, scheduler setup, and upstream backup/provider retention remain operational qualification tasks. They are not claimed as completed by unit/file tests. No Docker or hosted-service mutation is required to run the local regression suite.
