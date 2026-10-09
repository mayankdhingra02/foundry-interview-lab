# Evaluation and release evidence

This benchmark checks deterministic application behavior and provides a structure for independent AI quality review. These are separate measurements. Passing a validator, test suite, or Docker reference solution does not establish useful coaching, question relevance, rubric accuracy, accessibility, or learning improvement.

## Current assets and provenance

`evals/fixtures/attempts.json` contains 21 developer-authored attempts based on all five original scenario packages. The original 17 recipes are preserved: ten cover the unchanged reference and starter snapshots; seven add sparse explanation, confident incorrect reasoning, prompt injection in dialogue, unexecuted code, an old-snapshot run, rejection of a correct proposal, and acceptance of a bad proposal. Four versioned custom snapshots add an incomplete monetary-validation implementation, an intended alternative export implementation, and two declared technical-interruption states. Dialogue, edit decisions and interruption context are synthetic. There is no learner data, hiring label, demographic inference, expert assessment, or generated model output in this set.

`evals/fixtures/runtime-observations.json` retains the same genuine isolated Docker execution for the ten unchanged reference/starter snapshots. Every record binds scenario version and digest, snapshot digest, selected suite digest, inspected runtime image ID, timestamp, and actual observations. Materialization rejects capture reuse after a source or contract change and rejects ambiguous captures. Derived legacy attempts preserve their actual source run's snapshot identity; an old run is never relabeled as final-snapshot execution. No new execution was performed for the four custom cases.

Custom recipes must pin the scenario version, provide the full task-file payload with an independent snapshot version and matching SHA-256 digest, and declare `execution.kind` as `captured`, `unexecuted`, or `interrupted`. The same path and UTF-8 size validation used by saved workspaces applies. A captured custom recipe selects an exact immutable capture digest and must match the captured scenario, file and suite identities. An unexecuted or interrupted recipe never inherits a run merely because its bytes resemble a starter/reference implementation. Explicit states cannot combine with legacy run/edit transformations.

The custom monetary case contains a partial arithmetic repair with validation unfinished. The alternative export case is a plausible approach candidate, not a verified valid solution: execution and independent review remain pending. Interruption recipes record a developer-authored phase/reason only; they do not fabricate a job, timeout, failure, passing check, or actual disconnection experiment. All four contain no executed-test evidence. Fixture identity and execution context are included in `attemptContextDigest`, so changing code, fixture version or interruption context invalidates old model/review bindings even when other evidence is unchanged.

`evals/fixtures/human-review.template.json` is deliberately blank. No independent expert or paid model evaluation has been performed. The expanded v2 set remains a development regression set; it is not a protected acceptance holdout. Expand toward 40–60 reviewed attempts, execute and independently assess alternative/partial approaches, exercise actual interruption recovery, reserve task-family variants as holdouts, and collect separately consented learner examples before using the benchmark as beta acceptance evidence. The version bump intentionally does not carry old candidate labels forward.

## Run the deterministic benchmark

Run from the repository root with the existing Node/tsx runtime:

```sh
node --conditions=react-server --import tsx scripts/evaluate.ts
npm test -- tests/evaluation.test.ts
```

The `react-server` condition allows server-only scenario imports in this offline operator script. It does not start a web server. The default command replays captured observations, validates frozen evidence, and exercises actual server policy for unknown evidence, false universal test claims, prompt injection as data, and a stale assistant edit after manual changes. It neither executes learner code on the host nor calls model APIs.

The result reports each regression and a release state of `pending`, `blocked`, or `passed`. A pending result exits zero for ordinary regression CI; `--require-release` makes pending exit nonzero. A blocked result always exits nonzero. `--output PATH` writes the exact JSON summary. `evals/fixtures/baseline-summary.json` records the v2 deterministic run over 21 attempts, the ten existing actual runtime captures, and its pending AI release gate; those checks measure application contracts rather than model quality.

After an approved runtime or scenario change, explicitly recapture the ten execution records:

```sh
FOUNDRY_DOCKER_INTEGRATION=1 node --conditions=react-server --import tsx scripts/evaluate.ts --capture-docker --output evals/fixtures/baseline-summary.json
```

This requires a qualified Docker daemon and already cached approved Python image. The runner's isolation, resource limits and cleanup rules apply. Capture never pulls an image. A failed technical run does not overwrite the existing capture artifact. See `docs/execution.md` for qualification and remaining operational work.

## Record model outputs and independent review

No live provider benchmark is enabled by this CLI, and no API credits were spent for these assets. A future controlled provider run or reviewed offline import should create a `CandidateSet` using the schema in `evals/benchmark.ts`. Each candidate needs the case ID, context digest from `attemptContextDigest`, exact model and prompt/rubric versions, actual provider response ID and timestamp, structured coach report, and interviewer proposal. Bind output to the entire frozen evidence digest and scenario digest. The schema and recorded provenance fields are audit metadata; they cannot independently prove that an external provider produced an imported artifact.

Export full evaluator fixtures and create a review template bound to recorded candidate digests:

```sh
node --conditions=react-server --import tsx scripts/evaluate.ts --export-attempts /tmp/foundry-evaluator-attempts.json --candidates /tmp/foundry-candidates.json --annotation-template /tmp/foundry-human-review.json
node --conditions=react-server --import tsx scripts/evaluate.ts --candidates /tmp/foundry-candidates.json --annotations /tmp/foundry-human-review.json --require-release
```

Evaluator exports contain server-side task material, code, frozen evidence, fixture identity and the declared execution context. The last two fields preserve interruption/no-execution provenance and versioned snapshot identity for reviewers; they are not new execution observations. Keep real learner artifacts and private operational traces outside Git; use a restricted review workspace, explicit learner consent where applicable, and pseudonymous reviewer IDs. Do not expose evaluator exports through learner DTOs.

Have two experienced reviewers work independently before seeing each other's labels. For each candidate, both reviewers must record every rubric criterion, audit all substantive claims, flag fabricated execution claims, rate the actual follow-up question, flag critical solution leakage, explain uncertainty, and attest independent review. `Not observed` is separate from the three ordinal skill bands: a missing observation does not count as being one band away from an observed rating. Audit completeness is a human attestation, not something the metric calculator can verify from prose alone.

The adjudicator names both reviewers and resolves their disagreement against cited artifacts and anchored rubrics. Complete the `adjudication` object only after both reviews. Record decisions, evidence citations, error severity and actionable corrections in notes. The calculator requires distinct reviewers, complete criterion coverage, an exact reviewed candidate digest, matching context, consistent review chronology, and matching adjudication reviewer IDs. Model agreement never substitutes for these reviews. Identity and independence attestations still need the team's review process; JSON fields are not identity verification.

## Proposed gate calculation

The scoped AI gate uses the design document's proposed targets:

- All deterministic regressions pass and all candidate evidence references validate.
- At least 40 curated attempts have recorded model outputs and two independent adjudicated human reviews.
- At least 95% of audited substantive claims are supported.
- At least 85% of criterion ratings are within one anchored band of adjudicated expert labels.
- At least 90% of reviewed follow-ups are relevant.
- Zero fabricated executed-test results and zero critical solution leaks.

The summary exposes raw denominators, reviewer agreement, scenario and criterion breakdowns, pending prerequisites, and blocking failures. Unreviewed outputs remain pending; an absent quality metric is `null`, never a perfect score. Any fabricated test result or critical solution leak blocks this gate regardless of averages. Unknown or duplicate cases, missing regression coverage, changed candidate output, invalid schema, stale evidence context, or invalid provenance cannot silently qualify.

These thresholds are product targets. A benchmark pass covers this AI feedback/interviewer slice only. Separate public-host isolation review, shared admission/reconciliation, accessibility review, recovery tests, load/latency budgets, consent/deletion checks, and a 20–30-person learning pilot remain required before broad beta. Compare fresh-task performance at matched difficulty and recorded assistance; do not infer learning gain, fairness, or hiring outcomes from fixture scores or satisfaction.

Re-run after changes to prompts, models, schemas, rubrics, scenario contracts, evidence construction, runtime images, retrieval or tools. Preserve revisions and retire stale candidate/review artifacts rather than copying labels forward. Fine tuning is not required to run this workflow; propose it only after a reviewed benchmark demonstrates a persistent baseline gap.
