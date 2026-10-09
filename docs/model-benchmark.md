# Controlled model recording and comparison

`scripts/benchmark-models.ts` can plan or explicitly record the production interviewer, coach, and coding assistant independently. Assistant ask, plan, and edit are separate tasks. Each task uses the existing production context construction, privacy boundary, structured output validation, and output-token limit. It has no execution tools, does not apply proposed edits, and never executes learner code. The local regression corpus remains developer-authored; this tooling does not create a protected holdout or supply expert review.

## Plan without calling a provider

Run from the repository root with Node 22.13 or newer:

```sh
node --conditions=react-server --import tsx scripts/benchmark-models.ts --cases money-starter --roles interviewer,coach,assistant-ask,assistant-plan,assistant-edit
```

The default is always a zero-call plan. It prints selected roles, planned call count, configured model, corpus identity and a conservative total reservation using the application's configured input/output rates. `--cases` selects distinct known case IDs; omission selects the whole current corpus. `--roles` selects distinct supported roles; omission selects all five tasks. No runtime capture, provider request, code execution, payment operation or human annotation occurs in plan mode.

## Explicit paid recording

Only an operator with approval for the provider account, input handling and total spending cap should run recording. Configure the normal server-side `OPENAI_API_KEY`, `OPENAI_MODEL`, price variables and feature flags; coach recording also needs report generation enabled. The script does not read `.env.local` implicitly. Supply a private environment through the approved deployment mechanism or Node's explicit environment-file option.

```sh
node --conditions=react-server --import tsx scripts/benchmark-models.ts --cases money-starter --record --acknowledge-paid-api --max-usd 1 --output work/model-review/baseline.json
```

This example is an operator command, not evidence that a paid run was performed. The cap must cover the **entire** selected plan before any calls begin. A different model needs explicit prices under the existing model policy. Run challengers separately with the same cases, roles and prompt version; model and tariff differences are recorded per run. There is no automatic fallback to another model or provider in this harness.

The output file is created exclusively with mode `0600`, and new parent directories use `0700`. An existing output is never overwritten to start a run. Keep recording artifacts in an ignored private workspace; they contain outputs, attempted code patches, provider IDs and inference metadata. Do not commit completed artifacts or send them to learner APIs. File permissions do not replace appropriate directory permissions, volume encryption and reviewer access controls.

A private journal is durably saved before the first call and before every task. The outstanding entry retains its complete reservation. Each terminal result records the actual response ID, requested and returned model, prompt version, rubric/scenario context, known cost, uncertainty and provider completion timing. Authored fallbacks, invalid schemas, unsupported claims, missing provider provenance and forbidden assistant patches are rejected candidates. Known billed usage remains recorded even when output is unusable. Unknown billing stops the entire run without retrying, preserving the full uncertain reservation. A cost above the configured conservative bound also stops further calls.

USD values use recorded token usage and the configured tariff; they are not independently reconciled invoices. The cap relies on correct approved prices and the adapter's input/output bounds. Verify account tariffs before recording, and reconcile the resulting usage with the provider separately.

Writes use a synced private temporary file followed by atomic replacement of the task-owned journal. If persistence fails, no next provider call starts. A process crash can leave a `reserved` entry: treat that amount as uncertain, inspect provider usage with the recorded account context, and retain the artifact. There is deliberately no resume, overwrite or retry switch. A new run is a new possible charge and requires the same explicit authorization and cap. The application admission ledger is not used for this operator workflow; its cap and journal are separate from learner entitlements.

## Compare recorded runs and prepare review

```sh
node --conditions=react-server --import tsx scripts/benchmark-models.ts --compare work/model-review/baseline.json,work/model-review/challenger.json --output work/model-review/comparison.json
node --conditions=react-server --import tsx scripts/benchmark-models.ts --review-template work/model-review/baseline.json --output work/model-review/review.template.json
```

Comparison rejects duplicate runs, inconsistent entry/context hashes, incomplete runs mislabeled complete, incompatible benchmark/prompt versions and invalid accounting. It reports each requested model and role separately: planned and attempted tasks, validated outputs, known and uncertain cost, timing sample count, and p95 time from request start to the complete provider response. This is **not** first-token latency, learner-perceived latency or semantic quality. Provider response IDs and imported provenance fields remain audit metadata, not cryptographic proof of an external call.

The review template binds each validated role output to its exact digest and leaves both reviews and adjudication blank. Two experienced reviewers must independently inspect actual artifacts and assistance policy, then adjudicate meaningful differences. For the interviewer, check relevance, premise support, coverage and solution leakage. For the coach, check claim support, rubric agreement, uncertainty and useful next steps. For the assistant, check request satisfaction, forbidden changes, fabricated execution claims, correctness of proposed edits and overhelping under simulation policy. Validate proposed code using the qualified isolated runner, rather than treating a well-formed patch as correct.

Quality always remains `pending-independent-human-review` in this comparison. The existing paired coach/interviewer gate in [evaluation.md](evaluation.md) has a separate schema and adjudication workflow; role-run journals are not silently coerced into that legacy format. Role-specific expert scoring/import, protected acceptance cases, live provider qualification, and pilot learning evidence remain release work. No inference credits or actual human labels were used to develop these fixtures and tests.

## Verification boundary

`tests/role-runner.test.ts` covers zero-call planning, explicit admission, full-plan budget checks, reservation-before-call ordering, persistence failures, uncertain and excessive charges, role separation, assistant file policy, private exclusive output, compatible comparison and blank review templates. The production provider adapter is exercised with mocked HTTP for every role. These tests establish deterministic recording behavior; they do not establish account access, actual billing, live model performance or an approved spending budget.
