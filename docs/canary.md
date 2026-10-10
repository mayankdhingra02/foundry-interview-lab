# Disposable local component canary

`scripts/operations/canary.ts` is a reusable operator component check for durable save, isolated execution and the frozen-evidence report path. It uses an original harmless addition exercise that is never registered in the learner catalog or included in authored-content, expert benchmark or release-quality counts. The default command only prints a plan:

```sh
node --conditions=react-server --import tsx scripts/operations/canary.ts
```

This default does not create files, connect to a database, initialize application/auth/billing/provider clients, inspect images or invoke Docker. Unknown arguments and incomplete run authorization fail before any action. The script does not automatically load `.env.local`.

## Explicit execution context

The operator must first provision and approve a dedicated disposable or separate canary Docker context, with the reviewed immutable Python image already cached. Do not point this command at a shared learner execution daemon. The acknowledgment below asserts that the selected Docker context is appropriate; the script cannot independently establish host ownership. Configure `DOCKER_CONTEXT` or the Docker connection variables according to that approved context, `RUNNER_MODE=docker`, the approved aliases in `RUNNER_ALLOWED_IMAGES` when necessary, and an actual reviewed `PYTHON_IMAGE_ID=sha256:…` (64 lowercase hexadecimal characters). Follow [runtime binding](runtime-binding.md) for admission and image provenance; no synthetic ID is a valid operator substitute.

Then explicitly request one run:

```sh
node --conditions=react-server --import tsx scripts/operations/canary.ts \
  --run --context disposable-local --acknowledge-isolated-execution-host
```

The command creates a new UUID synthetic owner and a new private temporary directory (`0700`) containing a `FilePracticeStore` (`0600` file). It ignores configured `DATABASE_URL`, `PRACTICE_DATA_PATH` and application accounts. It accepts no existing store, owner, scenario, workspace path, source text, arbitrary command, output path or provider budget argument. Nothing is added to learner history or paid allowances. Concurrent invocations get separate owners and stores.

## Exercised path and limits

The canary calls the existing `SessionService` for create, one acknowledged workspace save, exact request replay, fresh-adapter reload, run admission, job claim and fenced completion. It verifies the saved snapshot hash, private scenario digest, job input fingerprint, test suite/runtime policy and admitted immutable image binding before execution. It passes the durable snapshot to the existing isolated `executeScenario` runner with protected checks enabled. The fixture has one unittest file, a 10-second total execution budget, a 2-second check budget and 128 MB memory. The runner provides its existing nonroot, read-only, network-free, no-host-mount container boundary and bounded management/cleanup operations; no learner code runs on the application host. It never pulls an image or substitutes a later alias.

There is one run and no retry. The driver signal expires after 60 seconds; runner cleanup deliberately does not inherit cancellation. The job lease is 120 seconds, and completion must still pass the service's fencing and runtime-digest checks. File operations use the existing local adapter's bounded lock wait; this is not a hard real-time wall-clock guarantee for a failing filesystem.

A valid completed check is required before the canary proceeds through **Finish coding**, one authored interviewer question, and **Final submit**. It submits no fabricated learner explanation. All non-run jobs are admitted with zero reservation and `forceAuthored`; no AI, voice or billing adapter is imported or called. The synthetic coach output passes the normal report validator, retains the frozen evidence and marks every criterion **Not observed**, with an explicit synthetic observation-only heading/model/version. The final report and evidence are checked again through a fresh adapter, including test evidence's actual runtime and snapshot identity. This checks storage/policy/report plumbing; it does not measure coaching quality or candidate skill.

## Result and cleanup

The final JSON contains fixed safe categories, boolean checks, counts, elapsed duration and cleanup state. It does not emit code, transcripts, test output, credentials, private traces, owner/session IDs or runtime IDs. Exit code zero requires every path check and session erasure, plus confirmed task-owned storage cleanup. Run failure, skipped/missing/unknown tests, mismatched runtime, missing report, corrupted reload, interruption, fencing or cleanup failure cannot be reported successful. No existing operational hold is cleared.

Normally the driver erases the synthetic content through `deleteAccount` and removes its own temporary directory. The shared Foundry identity is never involved. On unconfirmed execution cleanup or an unexpected executor rejection, it exits nonzero, retains only a `0600` content-free `cleanup-hold.json` in that task's private directory, and reports `operatorActionRequired` plus the notice path. A failure to erase/remove storage also exits nonzero. The existing runner's process latch is preserved; the notice is not a shared database circuit breaker. Reconcile the dedicated context through the existing bounded operator workflow before reusing it, then remove only the reported task-owned notice directory. Never infer that a later canary result authorizes clearing a learner execution hold, restarting Docker or pruning unrelated resources. An abrupt process/host crash may leave the synthetic private directory and execution container; operator reconciliation remains necessary.

## Evidence and remaining deployment work

`tests/canary.test.ts` exercises actual temporary filesystem save/reload/cleanup and injected execution. Injected summaries are always labeled `injected-contract-fixture`, with `fixture-asserted` execution cleanup and an explicit absence of real container/host qualification. The real CLI has no injection flag. Default-CLI tests prove zero-action behavior; they do not qualify Docker. No actual canary container, provider, shared-host operation or live paid call was run while implementing this capability.

Design §18's hosted canary remains a deployment gate: a separate approved hosted identity/database namespace and execution context, deployed ingress/worker exercise, bounded scheduling, content-free persisted observations, alerts and cleanup/recovery qualification are still required. This FileStore component smoke does not satisfy those integrations, availability/load targets or public sandbox qualification. Fresh final PostgreSQL/Docker/deployment-image/load evidence is also still pending under the documented GitHub account billing restriction; historical exact-commit passes and failures retain their original scope.
