# Practice mutation and processing admission

`lib/interview-practice/admission.ts` adds deterministic growth controls to the existing `PracticeStore` transaction. These are conservative beta defaults, not measured production capacity. They complement scenario/invite admission, per-attempt limits, billing entitlements, provider budgets, and store row/byte limits; they do not replace them.

## Policy and configuration

All counts are scoped to the verified account ID, except the shared processing ceiling. A minute is a rolling 60 seconds; a day is a rolling 24 hours. A request exactly one full window old stops consuming that window. Defaults apply locally and in production. Production access remains closed by the separate rollout defaults.

| Environment variable | Default | Meaning |
| --- | ---: | --- |
| `PRACTICE_OWNER_MUTATIONS_PER_MINUTE` | 30 | Acknowledged ordinary actions per owner in 60 seconds. |
| `PRACTICE_OWNER_MUTATIONS_PER_DAY` | 1000 | Acknowledged ordinary actions per owner in 24 hours. |
| `PRACTICE_OWNER_SAVES_PER_MINUTE` | 90 | Acknowledged workspace saves per owner in 60 seconds. |
| `PRACTICE_OWNER_SAVES_PER_DAY` | 5000 | Acknowledged workspace saves per owner in 24 hours. |
| `PRACTICE_MAX_OWNER_HISTORY` | 50 | Retained attempts per owner, including completed attempts. |
| `PRACTICE_MAX_OWNER_REQUESTS` | 5000 | Retained learner request-cache records per owner, across attempts and services. |
| `PRACTICE_MAX_SESSION_SNAPSHOTS` | 512 | Soft ceiling on learner-created snapshots in one attempt. |
| `PRACTICE_MAX_SESSION_EVENTS` | 3000 | Soft ceiling on learner-created event history in one attempt. |
| `PRACTICE_MAX_GLOBAL_PENDING_JOBS` | 20 | Shared queued plus running practice jobs. |
| `PRACTICE_MAX_OWNER_PENDING_JOBS` | 4 | Queued plus running practice jobs across an owner's attempts. |

Unset or empty variables retain defaults. Explicit values must be decimal integers from 1 through 1,000,000; zero, negative, fractional, scientific notation, hexadecimal, whitespace, or malformed values fail configuration. Raising a ceiling requires capacity review. Restart all application instances together after changing configuration; different configurations on different instances do not provide a uniform limit. Service constructors accept `admissionLimits` overrides for deterministic tests.

These are counts rather than storage-size promises. Existing request-body, file-size, event-schema, database aggregate row/byte and SQL statement-timeout limits remain authoritative and can reject work before a count ceiling. Do not raise the store's aggregate bounds merely to fit all possible combinations of the limits above.

## Transaction ordering and durability

An existing matching request returns its acknowledged response before admission checks. A reused key with different input remains a conflict. Erased request markers are checked before fresh work. Ownership is checked before capacity diagnostics, including job cancellation; foreign or missing targets return their ordinary not-found response.

Within the same transaction, admission counts persisted successful request records, checks new-attempt history before the database entitlement debit, captures history/job counts, performs the mutation, and checks resulting growth before committing the response cache. New jobs are also checked before reservation. A post-mutation failure rolls back snapshots, events, request caches, jobs, database entitlement changes and provider reservations together. No provider call occurs in these admission checks. A report retry that requeues an existing terminal job is checked by the resulting shared pending count.

`SessionService`, `InteractionService`, and learner `ReviewService` creation/consent operations use the same rules and database. New request keys cannot evade their shared allowance. The existing store lock serializes independent service instances; PostgreSQL uses its existing transaction/advisory lock. No new migration or independent in-memory rate counter is introduced.

Each successful request stores content-free `{ admission: { version: 1, lane } }` metadata in the existing private runtime payload. The server selects the lane; clients cannot select it. The file adapter and PostgreSQL runtime payload preserve this metadata. Legacy records without recognized metadata conservatively count in both ordinary and save windows. Invalid or future timestamps in relevant admission history fail closed for new ordinary/save work and require operator review; they do not trigger deletion or correction of old evidence.

## Saving, recovery and accepted obligations

Workspace saves have a separate rate allowance, so ordinary-action bursts do not consume save capacity. A rejected save is not acknowledged: the previous snapshot and revision remain authoritative, and the response tells the learner to retain or download the local draft. No snapshot or event is pruned or truncated to make room. The retained-request ceiling still applies to saves; it bounds copied session-response growth across all learner actions.

The following remain available at learner rate/request/history ceilings:

- Reading saved attempts and exporting owned data.
- Deleting an attempt or the account.
- Actual cancellation of a queued/running owned job.
- Valid finish, final submission and resume transitions.
- Bounded recovery of a failed/cancelled report with frozen input and no published report.
- An actual reduction of existing support permission, without simultaneously granting a new permission.

Repeated cancellation of an already terminal job, no-op permission updates, renewed consent grants, and non-recovery report requests use the ordinary lane. This prevents unlimited fresh recovery keys from becoming a cache-growth bypass. Recovery remains bounded by canonical state transitions, existing retry limits and original budgets. Jobs created by finish/submit/retry still respect shared processing capacity; a full queue can delay those operations, while saving, export, cancellation and deletion remain available.

Account deletion is recovery-exempt while owned sessions or request responses other than exact plain `{ deleted: true }` acknowledgments remain. Once only those harmless acknowledgments remain, fresh no-op account-deletion keys use ordinary admission; matching acknowledged deletion keys still replay first. The deletion workflow also applies its independent no-op acknowledgment bound and does not create new tombstones from prior harmless acknowledgments.

Worker claim, heartbeat, completion, failure and settlement are not learner-admission operations. Accepted work can finish even at a learner event ceiling. Recovery, worker finalization and authorized staff corrections may exceed the soft session event ceiling to fulfill existing obligations. The application never discards acknowledged evidence to enforce that ceiling.

Authorized staff review actions retain their existing exact account authorization, consent checks and canonical audit trail. Their cache records use the separate `staff` lane and do not consume the learner's rates or retained-request allowance. Staff access/audit growth needs its own operational access controls and monitoring; this module does not impose a new staff-rate policy.

## Operational limits and qualification

Pending counts include all saved queued/running practice jobs of every kind, across workers and application instances. They bound admitted work; they do not prove throughput or independently size CPU/container concurrency. Speech relay and payment-provider operations have their separate admission controls. Keep worker concurrency and sandbox capacity aligned with these ceilings and run the existing load/recovery qualification before widening access.

Only successful acknowledged mutations consume these rate windows. Rejected requests, failed logins and read traffic need deployment-level edge/WAF limits; this is not a failed-authentication or network abuse limiter. Account deletion removes copied request history, so subsequent owner rate-window counts can restart. Existing daily admission and spending ledgers survive deletion according to their separate retention policy. No independent permanent anti-abuse history is claimed.

Request-cache retention has a 30-day minimum eligibility, longer than the 24-hour rate window, and protects active attempts. Safe expiry of old terminal caches therefore cannot erase live rate inputs. See [retention.md](retention.md). Deleting older attempts can free retained history/cache capacity. Before changing limits or investigating malformed records, use count-only operational diagnostics and the approved backup/restore procedure; do not log learner files or rewrite canonical evidence.

`tests/admission.test.ts` covers concurrent owners and service instances, exact rolling boundaries, replay at capacity, save-lane separation, history and cache ceilings, atomic snapshot/event rejection, no losing-side provider reservation, report requeues, ownership diagnostics, cross-service interview/support admission, permission revocation, worker completion, export, and deletion. The ordinary regression suite uses synthetic fixtures and no paid provider calls. Real PostgreSQL serialization and load use the repository's separate disposable qualification jobs; hosted traffic thresholds and production latency remain unqualified until measured in the intended deployment.
