# Registered private-file cleanup

This is an operator-run cleanup capability for registered Interview Lab files belonging to permanently closed accounts. It does not upload files, create a bucket, delete Auth, run a model or sandbox, activate voice/billing, schedule a service, erase provider records or expire backups. The normal application currently stores snapshots and reports in SQL; an installation with no registered object keys needs no object request.

The fixed bucket is **`interview-lab-private`**. The only recognized bucket-relative path is:

```text
owners/<lowercase owner UUID>/sessions/<lowercase session UUID>/artifacts/<lowercase artifact UUID>
```

UUIDs use the standard version/variant shape. There are no arbitrary paths, extensions, URLs, bucket prefixes, encoded escapes, wildcards or recursive listings. The record owner must match the path owner. An account-closing anchor may contain objects from multiple sessions of that owner. An earlier session-deletion inventory is eligible only after that same owner is permanently closed, and its path session must also match the deletion record's session. Unknown, foreign and legacy keys stay pending for reviewed reconciliation; the worker never guesses their target. Merely being shaped like a key does not register an upload: the writer must commit its owner-bound artifact/snapshot metadata through the guarded transaction before closing captures the inventory.

## Atomic progress and retries

`runPrivateFileCleanup(store, objects?, options?)` defaults to a dry-run over the configured `PracticeStore`. The result contains aggregate counts only, including unknown/unanchored keys, leases, deferred/exhausted retries and completed records. It contains no owners, paths, request bodies, raw errors or credentials. The private inventory remains private server metadata.

Apply first checks the exact bucket's metadata and requires its ID/name to match and `public === false`. A missing, public, denied, malformed or unavailable bucket blocks all deletion without claiming work. No bucket is created automatically. Every claimed inventory must belong to an owner with a validated immutable permanent-closing fence and its surviving account cleanup anchor; an earlier session's inventory need not itself be the anchor. An unfenced owner is never processed.

Claims and progress updates use the existing `PracticeStore.transaction` and advisory/file lock. **All Storage HTTP requests run outside those transactions.** The caller must use the same trusted project as the metadata store. A claim records a SHA-256 target binding over the exact Storage origin, fixed bucket and key-policy version. A later process cannot silently change this target during a retry. The first target still requires deployment qualification against the actual metadata database; a digest is not an independent proof of correct operator configuration.

For each recognized key the worker issues a single-key delete, then an independent bounded exact-object metadata request. Delete success or a lost response is insufficient. Only a recognized `NoSuchKey` response with HTTP400/404 from the already verified bucket proves absence. Generic404, authentication errors, unknown codes, malformed metadata, a missing bucket or transport failure preserve the key. An existing metadata response must identify the exact key. The adapter never downloads file contents or follows redirects.

Each successful absence observation is applied under the original token, unexpired lease, unchanged owner/fence/target and unchanged remaining inventory. A stale callback cannot clear a newer claim or changed inventory. Verified keys are removed one at a time, so later errors do not undo acknowledged progress. Cancellation keeps an unverified key, releases a current claim with a content-free error, and does not infer that an aborted delete was rolled back. An expired result cannot acknowledge progress; a later claim can independently reconcile an already absent object.

Limits in `PRIVATE_CLEANUP_POLICY` are deliberately conservative:

| Bound | Value |
| --- | --- |
| Records per command | Default 1, maximum 5 |
| Objects per whole command | Default 10, maximum 20 |
| Captured inventory | Maximum 1,000 unique keys, 200,000 total key bytes, 2,048 bytes/key |
| Metadata response / HTTP request | Maximum 16 KiB / five seconds, including transport and body handling |
| Claim lease | Five minutes |
| Total claims / failed retries per inventory | Maximum 1,008 / 8 |
| Retry delay | Five seconds with exponential increase, capped at five minutes |

The public state remains `pending` or `completed`. Optional strict `cleanup` metadata contains `version:1`, `targetDigest`, `attempt`, `failureCount`, `claimToken`, `leaseExpiresAt`, `nextAttemptAt` and `lastError`. Its only error codes are `object_still_present`, `absence_unverified` and `interrupted`. Existing SQL `attempt`, `claim_token` and `lease_expires_at` columns mirror those fields; no new cleanup migration is required. Rows without this optional metadata retain legacy compatibility and start with attempt 0/no lease. Invalid metadata fails closed.

Successful bounded partial batches do not consume failed retries or force a delay; the same command's visited set still prevents repeatedly selecting one record. A failed/interrupted batch increments `failureCount` once and applies backoff. An expired crashed claim counts as one additional effective failure on reclaim; if that reaches eight, it is held without another Storage call. This expired-claim calculation is stable across repeated dry-runs and cannot keep incrementing itself. The 1,008 total-claim bound permits 1,000 successful one-object chunks plus eight failed attempts without creating an unlimited loop.

Completion requires an empty inventory and clears token, lease, retry time and error. The permanent anchor retains only its opaque lifecycle identities, timestamps and minimal attempt/target binding; it does not retain deleted keys or learner contents. The immutable closing fence is never removed or reopened. Existing retention preserves its referenced completed anchor. Other completed session cleanup records remain subject to the separately documented retention policy.

## Manual command

No additional hosted process or paid service is enabled by this patch. An operator may inspect counts without Storage credentials:

```sh
node --conditions=react-server --import tsx scripts/private-file-cleanup.ts --dry-run
```

The command selects the existing PostgreSQL store when `DATABASE_URL` is supplied, or the development file store otherwise. It never constructs the application/billing/model/voice/runner services. Dry-run reads metadata only and does not create a missing local file store. It does not run Storage bucket checks.

Apply requires the following, supplied through the existing secure environment mechanism:

- `FEATURE_PRIVATE_FILE_CLEANUP=true` (disabled by default).
- `PRACTICE_PRIVATE_STORAGE_PROJECT_URL` equal to `NEXT_PUBLIC_SUPABASE_URL`, with the reviewed project's HTTPS Supabase origin.
- The existing service-role credential, never a browser-supplied key.
- A matching database project: direct `db.<project>.supabase.co`, or a Supabase pooler username ending in that exact project reference. An unknown proxy/project mapping is rejected rather than inferred.
- Explicit command mode and deletion acknowledgment:

```sh
node --conditions=react-server --import tsx scripts/private-file-cleanup.ts \
  --apply --acknowledge-private-file-deletion --max-records 1 --max-objects 10
```

Environment files are loaded only if the operator explicitly supplies Node's `--env-file-if-exists` option. Logs are aggregate JSON. Do not print the environment, private key inventories, HTTP headers or upstream errors. Hosted Storage operations may count against the provider's existing allowances; qualification must use the approved zero-additional-spend plan. This document does not authorize a new plan, schedule or paid feature activation.

For owned disposable fixtures only, `--allow-local-storage` permits an explicit loopback HTTP Storage port with a matching loopback database. Production rejects this option. The module can also receive an already qualified `PracticeStore` and `PrivateObjectStore` from a host; that host must enforce the same exact project and privileged-server boundary. No public cleanup HTTP route is introduced.

## Recovery and evidence

On partial failure, rerun dry-run and let backoff/lease deadlines pass before applying again. An in-flight delete may have succeeded despite a timeout; the next attempt's independent absence probe resolves that safely. Eight failed attempts, the total-claim bound, changed target, unrecognized namespaces or contradictory metadata require reviewed reconciliation. There is no command that discards pending keys, clears the permanent fence or silently resets the attempt count. Preserve pending inventory while investigating; only verified absence can remove a key.

`tests/private-file-cleanup.test.ts` covers read-only default, private-bucket refusal, completion, earlier session inventories, mixed unknown keys, partial progress/backoff, lost response, concurrent claims, external calls outside transactions, stale/expired callbacks, cancellation, changed target/inventory, failed retry and successful batch limits, malformed inventory and file restart. `tests/private-object-store.test.ts` covers fixed origin/bucket/path construction, missing-object/error distinction, bounded responses, cancellation and timeout. `tests/private-cleanup-cli.test.ts` invokes the actual command with a clean synthetic environment and proves default no-write/paid-feature isolation and fail-closed apply gates. These use synthetic offline transports and identities. They do **not** establish actual hosted deletion or a passing Storage/Supabase integration. Root's separately owned local qualification must upload harmless synthetic bytes to the actual local Storage API, verify absence and other-owner isolation, retry partial failure and leave zero objects before a backup fixture that requires empty object storage. No genuine provider calls or independent review are manufactured by unit results.
