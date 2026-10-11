# Usage accounting after permanent account deletion

Migration `202610090011_durable_usage_ledger.sql` keeps the existing `ai_practice_usage_ledger` as the single authoritative operational quota ledger. It removes that table's exact `auth.users` foreign key. No ledger is copied, summarized or mirrored, and no existing posting is re-dated or rewritten. The retained `user_id` is an opaque UUID accounting identity; there is no session or Auth foreign key. These identities, operation IDs, timestamps and voice fingerprints are linkable metadata, not anonymous data.

Previously, migration0001 intentionally cascaded personal usage rows when Auth was deleted. Permanent closing could preserve a running reservation before that cascade, but the subsequent Auth deletion removed its contribution to global quotas. With migration0011, Auth deletion removes private session contents through their existing cascades while content-free usage postings survive. The permanent account fence remains independent and prevents new work under that closed owner ID.

## Schema and runtime boundary

The append-only migration validates existing payloads before removing the FK. A malformed legacy payload makes the transaction fail; the migration does not silently drop fields, erase commitments or guess replacements. Operators must inspect and reconcile such a failure through a separately reviewed process without exposing payloads in logs.

The validated `ai_practice_usage_content_free` constraint limits each posting to 8192 persisted JSON bytes and permits only `id`, `ownerId`, `sessionId`, `operationId`, `kind`, `amountUsd`, `createdAt`, optional `budgetAt`, and optional existing voice allocation metadata. It checks relational identity, kind, numeric money and timestamp parity. PostgreSQL money columns use eight decimal places; the original runtime numeric value remains immutable and its rounded relational value must agree. Voice metadata is bounded to its version/key/operation/request/fingerprint/seconds/characters/reserved amount/state/optional lease; no source, transcript, report, audio or provider body is allowed.

The ledger has RLS, no owner-read policy, and no PUBLIC/anonymous/authenticated table or column grants. The service role retains SELECT/INSERT/UPDATE/DELETE for normal adapter and bounded retention work, with no TRUNCATE privilege. `ai_practice_usage_immutable` uses the existing immutable-update function: an identical update is harmless, but an acknowledged posting cannot be changed. A terminal outcome is a new posting. Database administrators still control DDL; this does not defend against a privileged operator disabling the constraint or triggers.

The PostgreSQL adapter validates payloads and relational identity, amount, original session, kind and timestamp on load. `closeAccount` verifies the live no-FK/private-ACL/content-free/immutable boundary under the same `843239117` advisory transaction before either first closure or an existing closure acknowledgment. A legacy cascading schema fails before additional erasure and cannot authorize the host's next Auth-deletion step. Readiness requires the same accounting capability. A named constraint alone is insufficient: the adapter compares the reviewed expression while normalizing harmless PostgreSQL casts/parentheses.

Memory/file adapters already retain the ledger independently of Auth and remain development adapters. The PostgreSQL schema's strict ACL, constraint and trigger are actual SQL guarantees only after that schema is applied and qualified. No flag, feature activation or provider configuration is changed by this capability.

## Costs, original windows and late outcomes

Existing [quota arithmetic](quotas.md) remains authoritative. Identity includes owner, opaque session and the full job/voice operation prefix, including AI retry reservation sequence. Reservation `createdAt` owns the UTC budget window; an optional reservation `budgetAt` must identify that same instant. A later settlement or uncertainty marker keeps the original window, including across midnight or month boundaries. Retained deleted-owner rows still contribute to `globalDailyUsd`; they do not become the usage of a different account.

Before private jobs are erased, queued work known not to have called a provider gets a zero-actual-cost settlement. Running positive-cost work receives an uncertainty marker and keeps its reservation. Already terminal work gets no second terminal posting. Stale job heartbeats/completions/failures cannot revive the private attempt or use a late response to issue a guessed credit.

Voice callbacks and bounded voice reconciliation can append content-free accounting after closure and Auth deletion because the ledger has no account-open trigger or Auth dependency. A callback for a closed/deleted attempt returns no transcript/audio success and records uncertainty. Repeated callbacks or reconciliation do not duplicate terminal postings. Voice's original reserved seconds remain in global minute admission as well as shared USD admission.

Negative values are valid only for settlements. A negative settlement releases at most its exact single matching nonnegative reservation, only with one settlement and no uncertainty marker. Orphan, wrong-owner/session/sequence, duplicate and uncertain credits cannot release budget. Known actual usage above an estimate remains a positive delta. No operation here contacts a provider, cancels upstream work, returns money or establishes a provider invoice amount.

## Retention and reconciliation limits

The existing manual [retention policy](retention.md) removes only complete, unambiguous settled groups after every actual posting is at least 62 days old and all other eligibility checks pass. Auth deletion is not an extra expiry rule. Pending, uncertain and ambiguous commitments remain held; `expires_at` alone cannot authorize deletion. The existing 100,000-row scan bound, 64MiB adapter bound and bounded transaction timeouts remain fail-closed. A full store requires operator work, rather than pruning unresolved obligations to make room.

Voice reconciliation remains a dry-run by default, scans at most 100,000 postings and applies at most 500 reservations per operation. It marks a validated expired voice reservation uncertain, preserving original cost/minutes and releasing only in-flight concurrency. It never guesses a successful result or refunds the reservation. There is no new manual invoice/refund endpoint and no automatic settlement of uncertain AI debt. Actual provider reconciliation, if later needed, requires independently verified accounting evidence and its own reviewed policy.

The daily/monthly budget windows remain the existing limits; preserving an uncertain posting does not invent a new lifetime/global debt cap. Payment/subscription accounting is separate, and merchant-associated account deletion remains blocked by the host's commerce lifecycle gate.

## Verification and scope

`tests/durable-accounting.test.ts` checks the literal migration expression, bounded payload privacy, negative-money rejection, exact live capability checks, original-window uncertainty and another owner's global denial after permanent closure, using synthetic outcomes and no provider calls. Existing quota/store/retention tests protect conservative credit and retry semantics.

`tests/durable-accounting-postgres.integration.test.ts` supplies three opt-in isolated SQL cases: actual Auth cascade/restarted adapter/global denial; retained voice minutes and one late uncertain callback; and immutable/private/allowlisted enforcement plus closing refusal when a cascading FK is reintroduced. The existing readiness integration suite also rejects lost CHECK/trigger/no-FK protections and client column grants. These cases are authored until their explicitly authorized disposable run passes; default unit tests skip them.

Combined Foundry migration/RPC, pinned adapter execution, encrypted backup/restore and private-file cleanup require separate exact-source local evidence. Historical 102-migration qualification does not cover this new capability. All AI, execution, voice and billing services remain disabled for the $0 integration work. Local synthetic accounting qualification does not establish paid-provider bill accuracy, hosted activation, merchant reconciliation, long-term capacity or approved retention operations.
