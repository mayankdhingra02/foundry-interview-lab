# Recovering abandoned voice reservations

Voice processing runs in an authenticated, bounded HTTP operation. A process can exit after committing its reservation but before recording a final callback. Previously two abandoned requests could retain an owner's two concurrency slots indefinitely; 32 could retain every global voice slot. Money and minute allocations must remain conservative even after that operation is no longer eligible to return a result.

`lib/voice/ledger.ts` now implements `voice-reservation-v1`. New voice reservations persist `voice.expiresAt`, exactly 120 seconds after the original admission clock. The current speech fetch and response-body boundaries each use 25-second deadlines; the longer reservation window includes storage completion and a safety margin. The expiry is application metadata in the existing normalized ledger payload. Migration 0004 permits this additive field; no new schema or provider integration is introduced.

At expiry an unambiguous unmatched reservation may receive one terminal **uncertain** posting. It does not receive a successful settlement, refund, replacement request, or provider retry. The original reservation and its USD amount, seconds, characters and request identity remain unchanged. The uncertainty posting contains zero additional USD, the actual recovery timestamp, and the original reservation's `budgetAt`. Live session accounting moves reserved USD to uncertain USD without changing the total commitment or cumulative voice seconds. Deleted sessions are never recreated. The reservation continues to count toward its original user/global/day/month budget window and its original minute allocation; uncertainty is retained by the existing conservative retention policy.

Legacy reservations without `expiresAt` use `createdAt +120 seconds` only when their content-free group is unambiguous. The planner requires one valid reservation, unique ledger IDs, matching owner/session/operation identity and metadata, valid timestamps and configured bounds, and a consistent live-session reservation counter. An existing `budgetAt` must identify the original creation instant. An explicit expiry must match the fixed policy. Duplicate/orphan/inconsistent groups stay held and are counted as ambiguous; recovery never guesses a provider outcome or adjusts corrupted counters.

The policy version and duration must change deliberately if provider deadlines or processing steps change. This is an application eligibility lease, not an assertion that an external provider has stopped or has not billed. Clock synchronization is required on deployed web/worker/maintenance hosts; a clock jump may close an operation conservatively and force text fallback.

## Fencing late results

Every final callback must match the original admitted identity and usage metadata. A terminal posting prevents another callback from modifying accounting. A callback at or beyond expiry records uncertainty if needed and returns inaccessible, even if maintenance has not yet run. `VoiceService` discards inaccessible transcription/audio and preserves text fallback. Reconciliation neither stores nor returns audio, transcripts, question text, source code or provider errors. It does not authorize support content inspection.

Before a fresh voice admission, a bounded pass closes at most 32 eligible abandoned reservations under the same store transaction lock. This can recover all normal global concurrency slots while retaining monetary/minute limits. The original request key remains non-replayable and cannot trigger an automatic provider retry. If new admission fails another quota check, the entire transaction rolls back, including that recovery pass; operators can use the standalone maintenance command. No recovery runs on a rejected duplicate request or an unauthorized/non-voice attempt.

## Bounded operator command

```ts
reconcileVoiceReservations(store: PracticeStore, {
  apply?: boolean,             // default false
  maxReservations?: number,    // default 100; integer 1..500
  now?: Date,                  // deterministic tests only; CLI uses current clock
}): Promise<VoiceReconciliationResult>
```

Dry-run reads a consistent store snapshot and changes nothing. Apply recomputes eligibility under the existing PostgreSQL advisory lock or local filesystem transaction lock; it never reuses a prior dry-run selection. An apply closes at most the selected number of reservation groups. More than 100,000 aggregate ledger rows fails closed. This is bounded recovery over the current aggregate adapter, not a demonstrated large-scale SQL sweeper. `moreEligible` indicates another batch is needed. Malformed or ambiguous groups require reviewed operator investigation, not repeated blind retries or row deletion.

Use the configured application Node runtime and private server environment:

```sh
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/reconcile-voice.ts --dry-run --max-reservations 100
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/reconcile-voice.ts --apply --max-reservations 100
```

Omitting the mode is dry-run. `--apply` is explicit; conflicting modes or invalid bounds fail before opening storage. `--help` initializes no store. `DATABASE_URL` selects PostgreSQL directly; production refuses filesystem fallback. Local development uses the directory of `PRACTICE_DATA_PATH`. The command never initializes billing, model, speech or sandbox providers. No automatic scheduler is installed.

Output is limited to policy version, mode, timestamp, batch limit and aggregate examined/pending/expired/selected/reconciled/ambiguous counts plus `moreEligible`. It contains no owner/session/request/operation IDs or connection strings. Exit code 0 means the selected dry-run/apply completed; 1 emits a fixed safe failure category. If completion is uncertain after process interruption, run dry-run again; one committed terminal posting fences subsequent applies and late HTTP callbacks. Review the intended deployment and dry-run counts before applying; never release a charge merely because its operation is old.

## Verification and open gates

`tests/voice-reconciliation.test.ts` covers expiry boundaries, unchanged dry-run state, bounded and repeated apply, owner/global concurrency recovery, retained USD/minutes, UTC day/month attribution, legacy metadata, malformed groups, owner isolation, filesystem restart persistence, deletion, callback identity, and discarded late STT/TTS responses. Provider responses are synthetic and no speech calls are made. Existing voice/API/quota/deletion tests continue to exercise the unchanged limits.

`tests/voice-postgres.integration.test.ts` adds actual service-role tests for persisted expiry, concurrent exactly-once recovery through independent adapters, frozen original budget attribution, deleted legacy reservations and malformed-expiry preservation. These opt-in cases have not been executed locally. Final PostgreSQL/container/load qualification is pending because local Docker is unavailable/prohibited and GitHub Actions is blocked by account billing. Historical passing SQL results do not qualify this patch. Target deployment clocks, actual process termination, provider cancellation/billing behavior, real microphones, accents, speech latency and operating procedures still need separate staging qualification before enabling voice.
