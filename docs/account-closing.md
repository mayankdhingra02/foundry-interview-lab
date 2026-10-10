# Permanent account-closing fence

`SessionService.closeAccount(ownerId, { requestId })` is a trusted server lifecycle primitive. It permanently prevents this verified UUID owner from starting or changing practice work. It does **not** delete a Supabase identity, call an Auth API, cancel a subscription, erase upstream provider records, clean object storage, or activate Foundry integration. No public HTTP route is added.

Existing `SessionService.deleteAccount` and `DELETE /api/account` remain **Lab content deletion**. Their acknowledged scope is `interview-practice-data`, preserving the shared account and allowing a later fresh attempt. A host deleting an account must use `closeAccount`, await its committed result, and only then invoke its separately authorized Auth deletion. Calling content-only deletion before Auth deletion does not fence the intervening admission race.

## Contract and atomic boundary

```ts
await service.closeAccount(verifiedOwnerId, { requestId });
// { closed: true, scope: 'permanent-account-closing',
//   cleanupId: '<uuid>', cleanupState: 'pending' | 'completed' }
```

This method requires a UUID owner and the existing bounded request-key format. It canonicalizes the UUID to lowercase before ownership lookup or erasure, matching PostgreSQL UUID keys. The caller must obtain the owner from verified server authentication or its trusted account lifecycle; request bodies and browser storage are not authorization. There is no client-controlled owner or new browser activation in this patch.

One `PracticeStore.transaction` captures a bounded object inventory, creates a permanent owner fence and its cleanup record, settles untouched queued work at zero cost, records running cost commitments conservatively, removes all owned sessions/support contents and copied request responses, then commits. PostgreSQL uses the existing **scalar advisory transaction lock `843239117`**, which serializes the current adapter's writes across owners. This is not a new owner-specific lock. Host writers must preserve that protocol rather than choosing an unrelated lock key. PostgreSQL object inventory capture rejects another configured lock key.

The result contains only cleanup metadata. `completed` means the inventory is empty; it never means Auth deletion or provider-side erasure succeeded. `pending` means captured object keys still need the separately authorized object-cleanup workflow. The application currently stores its learner artifacts in SQL rows and does not populate the artifact table/object storage. The new capture covers existing artifact `storage_key` values and non-null snapshot storage keys if a deployment has them; it does not guess keys for another store.

Before transferring keys, PostgreSQL checks distinct inventory count (maximum 1,000), total key bytes (maximum 200,000) and largest key (maximum 2,048 bytes). It then validates the returned count and bounded JSON size (maximum 262,144 bytes). Capture only runs inside the same transaction/client. Failure, malformed storage or capacity overflow rolls back both closing and erasure. No Auth deletion should follow an unacknowledged closing transaction; retry the same closing operation to learn its durable outcome.

Repeating `closeAccount` after an acknowledgment is idempotent, including a different retry key: it returns the existing cleanup identity and current cleanup state without another fence, admission debit or copied response. A first close cannot reuse a key from an ordinary mutation or erased request. It does not write an Auth-bound idempotency row, so this retry works after `auth.users` cascades. An upstream Auth failure leaves the account fenced. There is no normal reopen method or expiry, and a retry never clears the fence. Host Auth deletion must handle its own success/ambiguous-failure state; this result is not an Auth deletion acknowledgment.

## Persistence and append-only migration

Apply standalone migration **`202610090010_account_closing.sql`** after the existing migrations. Existing `0001`–`0009` bytes are unchanged. The new private table is:

| Column | Type / purpose |
| --- | --- |
| `opaque_owner_id` | UUID primary key; permanent owner fence |
| `request_id` | Bounded first closing request identity |
| `fingerprint` | SHA-256 closing-operation fingerprint |
| `cleanup_id` | UUID reference to durable `ai_practice_deletions.id` |
| `created_at` | Timestamp of first committed closing |
| `runtime_payload` | Strict bounded typed metadata, no learner contents |

The table has **no Auth or session foreign key**. Its cleanup reference uses `ON DELETE RESTRICT`, so inventory cannot disappear behind a retained fence. The referenced deletion row has no Auth/session foreign key either. Both remain when the Auth user and all private practice rows cascade. The owner UUID is an opaque lifecycle identifier, not anonymous data; the fence and minimal cleanup anchor intentionally persist indefinitely. Ordinary 30-day deletion-metadata retention does not remove this anchor or the fence. Cleanup can clear keys and mark the referenced row completed without rewriting the fence.

RLS is enabled, with no anonymous/authenticated policies or grants. `service_role` receives `SELECT, INSERT, UPDATE`; no `DELETE` or `TRUNCATE` grant is added. Runtime upserts need the update privilege, but a trigger rejects any changed fence and every normal delete. Database administrators still control DDL/restore; this is not protection against a privileged operator disabling guards or truncating tables.

Four additional triggers guard session/job/snapshot/artifact insert or update under the same advisory lock and reject fenced owners. These protect the SQL write boundary even if an older caller attempts to recreate an erased session, and serialize registered object-key writes with inventory capture. Host object writers must register keys within this guarded transaction protocol; an unregistered object upload remains outside the inventory. The adapter additionally validates relational/payload identity, retains immutable fence metadata and refuses fence/cleanup-anchor removal. Memory and file adapters implement the same service fence and preserve it across file restart; they remain development-only.

Before the new table exists, normal baseline storage remains compatible; **permanent close fails closed without erasing content**. Table discovery shares the existing catalog request and retains batched loading/capacity preflights. A partially applied closing capability cannot be treated as qualified. Readiness checks the table's private grants/columns and enabled named fence/session/job/snapshot/artifact guard triggers whenever the table is present. An integrating host must explicitly pass `requiredFeatures: { accountClosing: true }` to `probeReadiness` before exposing a permanent account-deletion flow, so a completely missing migration is also rejected. This does not remove the existing schema, writer/BYPASSRLS or worker-freshness requirements.

The actual writer needs the new table's `SELECT, INSERT, UPDATE` privileges and existing deletion-table privileges, alongside the existing trusted-server RLS boundary. The staged restricted Foundry role is not upgraded by this patch. Foundry must import this standalone migration under a **new append-only host version** after its existing chain, then separately qualify the combined schema and lifecycle. No previously qualified migration count or backup result covers this new table automatically.

## Admission, workers and in-flight work

Ordinary session admission/mutations check closing state **before cached response replay** and fail with HTTP-compatible `409 account_closing`. Owner reads also reject closing accounts. Interview controls, voice admission/checks and target-owner support/correction/recovery mutations honor the same fence. A closing staff actor cannot add support audit/mutation records through its stale actor identity. Internal deletion-status/cleanup tooling still operates on the surviving inventory under its existing staff boundary.

Workers skip fenced owners before claiming queued/expired jobs. Heartbeat, completion and failure callbacks reject stale claims; closing removes their private session/job records atomically, so late callbacks cannot recreate a report or test result. An already admitted provider/execution request cannot be recalled merely by committing a database fence. Running positive-cost work remains uncertain, and no late output is returned for a closed account. Voice callbacks may reconcile content-free uncertainty while the usage row still exists, never return audio/transcript or recreate a session; after Auth cascade removes usage rows, they return no success. Provider retention and cancellation remain separate operational boundaries.

Backups/restores and export/deletion inventories in a host must include the new fence table and durable cleanup rows. Restoring old private content while omitting newer fences could reopen an account; a host must qualify its ordering/reconciliation before activation. This patch neither updates an Engineering Foundry deployment nor asserts that its account lifecycle, combined export schema, TLS or restore workflow is qualified.

## Evidence

`tests/account-closing.test.ts` exercises reusable content deletion, permanent idempotency, a concurrent admission transaction, file restart/corruption, rollback, protected cleanup anchors, voice/support/interview gates and fenced/stale workers. `tests/account-closing-store.test.ts` exercises relational reconstruction, exact lock/write ordering, no Auth-bound retry cache, missing migration, and inventory preflight/count failures with fake transport.

`tests/account-closing-postgres.integration.test.ts` supplies four opt-in disposable SQL cases for Auth-cascade survival/private inventory, deterministic real advisory-lock contention, stale claims/SQL guards/privileges/readiness, and atomic rollback of oversized inventory. It is included in the existing PostgreSQL CI invocation. These SQL cases are **authored, not executed locally** under the current no-Docker/no-database constraint. Default unit tests, typecheck and lint do not establish actual PostgreSQL or hosted qualification. No providers, Auth API or hosted database are invoked by the local checks.
