# Advisory timing and participation

Setup offers a base advisory duration, optional 15 or 30 extra minutes, and either text with optional voice or written-only participation. The selected target includes any extra setup time. The timer is elapsed wall time (including pauses); it never submits, locks, or stops an attempt. These are practice choices, not a request for a diagnosis or medical information. The new UI has no health/disability free-text field.

The server persists `configuration.practiceConditions: {timing: 'standard' | 'extra-15' | 'extra-30', participation: 'text-or-voice' | 'written-only'}`. Both fields are required when this optional object is present, and unknown nested keys are rejected. `configuration.originalTargetMinutes` is initialized by the server from the effective setup target; callers cannot set it. Existing sessions without either field remain readable. Legacy `accommodations: string[]` remains readable for compatibility; new setup does not collect that free text. Existing pending creation payloads are replayed unchanged, without adding new defaults to their request identity.

Written-only participation rejects `voice: true` at creation. The voice gateway independently checks the saved participation policy before reservation and before returning a completed voice result. Text remains available throughout. Selecting text with optional voice does not turn on microphone access or bypass separate processing consent, provider qualification, or budget checks.

## Explicit time extension

The workspace's **Advisory time** control displays the original/current targets and participation choice. Before final submission, an owner can add 15 or 30 minutes using:

```text
POST /api/interview-practice/sessions/:sessionId/timing
{requestId, expectedRevision, additionalMinutes: 15 | 30}
```

The transaction applies ownership, erased-request markers, exact idempotency, optimistic revision, and bounded mutation admission. Exact acknowledged replay precedes revision/lifecycle admission; reusing a key with another amount conflicts. Extensions are available during active coding, paused practice, and the code-frozen debrief. They are unavailable once final evidence is frozen or the lifecycle is reviewing/completed. No code snapshot, dialogue, job, or cost reservation is changed by the extension itself. If the editor has unsaved changes, the browser first uses its existing save flow; a failed save prevents the timing request and preserves the draft.

The original target stays fixed and each accepted extension appends a learner-sourced strict v1 `session.timing-extended` event containing the original, previous, and new target plus the amount. The schema validates the arithmetic. An existing session without an original target initializes it on its first extension. Targets are bounded at 180 minutes. When another offered extension would exceed that bound, the UI says work and saving can continue. The elapsed timer has no grading or termination authority.

Interrupted extensions use the existing owner-scoped browser recovery storage. The exact amount, revision, and original request key survive a reload. The UI disables a different new extension while its acknowledgement is unresolved and offers **Recover advisory time**. Recovery sends only the original request; it does not add the same time twice. The established 30-day idempotency horizon and explicit expired-retry discard policy still apply. These controls do not automatically dispatch browser-stored requests.

## Feedback and provenance

Reports explain the recorded targets, setup extra time, later extensions, and written-participation choice. Progress histories preserve original/current target, setup extra minutes, extended minutes, extension count, participation, and the count of recorded conditions. No deterministic rating or recommendation is lowered by these settings; missing explanations remain missing observations. Provider prompt version `foundry-2026-10-09-v2` explicitly forbids rating penalties or negative inferences from advisory time, extensions, or participation choices. It also adds the coordinated learner-authored-check origin boundary. This is an instruction and local contract check, not proof of model fairness or human acceptance. Existing reports and their prompt versions are preserved.

## Migration and verification

Apply ordered migration `202610090009_advisory_timing.sql` before deploying the timing event writer. Migration 7 remains unchanged; migration 9 extends its event vocabulary while preserving schema version 1 and all existing types. Readiness requires an exact match between the deployed SQL event vocabulary and the application schema; a database still on the earlier vocabulary is not ready for this writer. The readiness test catalog now follows the latest ordered event-constraint migration.

Focused local unit/HTTP tests cover typed choices, no medical keys, written-only server enforcement, original-target ownership, exact legacy creation replay, ownership and erased requests, changed-body conflicts, concurrent revisions, paused/debrief extension, immutable submitted conditions/evidence, no work or cost changes, the advisory cap, stored retry identity, and no deterministic rating changes. Mocked-provider tests inspect the revised instruction and recorded version; they do not call or qualify a model. Browser tests use intercepted synthetic APIs for setup recovery, lost extension recovery, keyboard focus, and mobile controls.

`tests/timing-postgres.integration.test.ts` is an authored opt-in using only the existing disposable PostgreSQL helper and all ordered migrations. It verifies actual event persistence and replay across independent stores when `RUN_POSTGRES_INTEGRATION=1` is explicitly enabled. Its real SQL qualification is pending until a fresh opted-in run succeeds. No Docker, hosted database, provider calls, or independent accessibility/pilot review was used for this change. Independent accessibility testing and representative learner acceptance remain required release evidence.
