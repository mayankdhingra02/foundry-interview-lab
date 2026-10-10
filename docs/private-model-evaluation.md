# Private corpus model recording and independent review

The separate `scripts/private-model-evaluation.ts` workflow bridges validated private development, acceptance and holdout cases into production interviewer, coach and assistant recording, then bound independent review. It uses the strict corpus/capture loader from [acceptance-corpus.md](acceptance-corpus.md). It never coerces a private case or run into the existing `development-regression` formats; those remain unchanged.

All artifacts start unreviewed. A completed model run is not human acceptance. A fully reviewed artifact is not release approval or evidence of sufficient holdout custody, sample size, accessibility, fairness or pilot learning improvement. No actual private acceptance corpus, live provider recording or human review was produced while implementing this bridge. Unit fixtures and mocked HTTP responses are hypothetical test data only.

## Zero-action default and zero-call plan

From the repository root with Node 24:

```sh
node --conditions=react-server --import=tsx scripts/private-model-evaluation.ts

node --conditions=react-server --import=tsx scripts/private-model-evaluation.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json \
  --compare-corpus /absolute/private/corpus/development.json,/absolute/private/corpus/holdout.json \
  --roles interviewer,coach,assistant-ask,assistant-plan,assistant-edit
```

No arguments print help and perform no action. A corpus argument without `--record` prints a count/cost plan and makes zero provider calls. Only roles from the fixed list are accepted. A run represents one to sixty cases and at most 300 case/role tasks; split a larger corpus into intentionally versioned operator-managed manifests rather than silently omitting cases. Current configured prices are needed for a new cost plan, not for offline review.

The loader checks the 21 published development recipes and explicitly supplied comparison corpora for cross-split overlap. It retains exact custom files, typed/transcribed dialogue, assistant messages, original timing/written conditions, and selected execution provenance. Missing execution remains missing; an offline snapshot replay does not become an original learner run. The recorder also checks known development overlap before admission. It has no code-execution, capture, edit-application or arbitrary host command option. Prepare runtime observations separately using the corpus workflow.

## Explicit paid recording

The following is an operator recipe, **not authorization to spend** and not evidence that it was run. Obtain the team's actual approval and configured provider account first. The CLI requires all of `FOUNDRY_PRIVATE_MODEL_RECORD=1`, `--record`, `--acknowledge-paid-api`, an opaque operator ID, a finite positive `--max-usd` no greater than 1000, and a new private output directory. The complete reservation must fit the cap before recording starts.

```sh
FOUNDRY_PRIVATE_MODEL_RECORD=1 \
node --conditions=react-server --import=tsx scripts/private-model-evaluation.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json \
  --compare-corpus /absolute/private/corpus/development.json,/absolute/private/corpus/holdout.json \
  --roles interviewer,coach,assistant-ask,assistant-plan,assistant-edit \
  --record --acknowledge-paid-api --operator model-operator --max-usd 5 \
  --output /absolute/private/evaluation/new-model-run
```

The production AI flag and, when coaching is selected, report-generation flag must be enabled. The bridge uses the actual production role functions, context/privacy construction and output validators. Assistant ask/plan cannot return patches; edit patches must stay inside the admitted workspace. Proposed code is not applied or executed. Authored fallbacks, missing provider provenance and rejected structured outputs never become validated model candidates.

A separate immutable JSON checkpoint is written before the first call, before each call's reservation, after each terminal observation and at finalization. The final file is `run.json`. Checkpoint filenames are exclusive, directories are new, writes are synchronized, and existing artifacts are never overwritten. A failed pre-call write makes no call. A failed result write leaves the earlier outstanding reservation; do not infer free usage or retry it as if it never happened. No resume/retry option exists. Reconcile actual provider usage manually before deciding on a separately authorized new run.

Unknown billing holds the full reservation and stops subsequent calls. A cost above the admitted bound stops the run and retains known charges. SIGINT/SIGTERM stops admission of subsequent tasks; it does not promise cancellation of a request already accepted by a remote provider. A process crash may leave a reserved checkpoint. Such incomplete, rejected or uncertain tasks supply no model-quality evidence.

## Separate holdout custodian unlock

A broad recording flag cannot unlock a holdout. The custodian must separately supply a private JSON artifact matching `holdoutUnlockSchema` in `evals/private-role-runner.ts`:

| Field | Required binding |
| --- | --- |
| `version`, `purpose` | `1`, `one-run-heldout-model-evaluation`. |
| `corpus`, `corpusDigest` | Exact ID/version/`holdout` split and canonical digest of the entire private manifest. |
| `runId` | A fresh UUID selected by the custodian for this recording; it becomes the recorded run ID. |
| `custodianId` | Exact manifest custodian ID. |
| `authorizedOperatorId` | Exact recording operator ID. |
| `acknowledgedAt` | Authorization timestamp no later than journal creation. |

Add `--holdout-unlock /absolute/private/custody/unlock.json` to the recording command. Retain the same file for later packet generation, templates and scoring. Missing, changed or mismatched authorization fails before persistence or inference. A non-holdout run cannot borrow this artifact to relabel its split.

This is a scoped custody attestation and digest binding, not a digital signature, authenticated user identity or globally enforced one-time token. The custodian must protect the file, authorize one run ID once, track disclosure and prevent reuse in a different output directory. The CLI does not modify or consume custody documents. Recording exposes the selected holdout material to the configured provider; it must never be repurposed for prompt tuning. Real permission, retention and independent holdout handling remain team obligations.

## Immutable identity across recording and review

`private-role-context-v1` identifies this context serialization. Every planned task binds the full private corpus digest, case digest, pre-execution input digest, final private context/evidence digest, execution digest, runtime binding digest, scenario/rubric versions, role, prompt version, assistant request, stage and exact workspace. Selected immutable runtime observations stay bound through the original private context. The plan digest excludes price reservations so the same tasks can be compared under different recorded pricing; recorded reservations are separately checked against the recorded policy.

Import reconstructs contexts from the original private manifest/capture set and validates the recorded journal. It does not trust an exported or externally assembled `Session` object. Changed bytes, dialogue, participation/timing conditions, split, package, capture, prompt/context, candidate output or entry accounting invalidate binding. Offline review uses recorded policy and prompt version and does not consult current model pricing or availability. Preserve every input artifact; changing a manifest version requires a new recording.

The CLI always uses `loadPrivateCorpus`, including the known development and supplied comparison indexes, before planning, recording or review. The pure `createPrivateRoleContexts`/offline validator helpers check schema and exact supplied context bindings; they do not discover other private files or automatically load the known development index. Direct programmatic callers must perform that loader/separation step. Paid recording additionally rechecks the known development index before admission; undisclosed private split exposure still requires custodian controls.

## Blind packets and blank annotations

```sh
node --conditions=react-server --import=tsx scripts/private-model-evaluation.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json \
  --run /absolute/private/evaluation/new-model-run/run.json \
  --packets --output /absolute/private/review/packets.json

node --conditions=react-server --import=tsx scripts/private-model-evaluation.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json \
  --run /absolute/private/evaluation/new-model-run/run.json \
  --template --output /absolute/private/review/annotations.json
```

For holdout artifacts also supply the matching private unlock. Packets and templates require private outputs; they are never dumped to stdout. They contain only validated candidate tasks. Every packet binds the exact candidate-entry digest, role/context and private corpus provenance, with faithful review evidence and candidate output. Candidate model identity, inference/provider IDs, prices, charges, model operator identity and peer labels are omitted. Reference files and protected test source are omitted as in the corpus export. Original assistant-message provenance remains part of the historical context. Candidate text can volunteer a model identity; metadata removal cannot guarantee blinding. Reviewers must truthfully decline the blinding attestation if they know the identity.

Give each experienced reviewer the same bound packet under separately controlled access without the full model journal or the other's labels. Record actual reviewers only; template `reviews` are empty and `adjudication` is null. No labels, expert identity, pass percentage or approval are synthesized.

Each submitted review requires `independent: true`, `candidateIdentityHidden: true`, `peerReviewsHidden: true`, its exact packet digest, actual reviewer ID, completion time and complete role-specific labels from the existing `roleAssessmentSchema`. Reviewers must be distinct after case/whitespace normalization and cannot be the model operator, source preparer or corpus custodian. These are attestations, not authentication by this offline tool.

Coach labels audit claim support and every authored rubric band. Interviewer labels audit relevance, policy compliance and leakage. Assistant ask, plan and edit are separate modes with usefulness, request compliance, policy compliance and correctness labels; correctness has a static-review basis, not an invented execution result. Claim IDs must be unique. Unknown criteria, wrong modes and contradictory no-claim declarations are rejected. Absent labels, missing observations, null safety flags and incomplete claim audits remain pending.

A separate independent adjudicator must name exactly the two independent reviewers and finish after both. The adjudicator cannot be either reviewer, the model operator, source preparer or corpus custodian. Adjudication must resolve the union of their audited claims and include complete role labels. Meaningful disagreements are counted even after resolution. Any bound review or adjudication flag of fabricated execution or critical solution leakage blocks the artifact; adjudication cannot silently erase that flag.

## Offline scoring

```sh
node --conditions=react-server --import=tsx scripts/private-model-evaluation.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json \
  --run /absolute/private/evaluation/new-model-run/run.json \
  --reviews /absolute/private/review/annotations.json \
  --require-complete --output /absolute/private/review/score.json
```

Scoring makes no provider or runtime calls. It reports per-role/per-scenario coverage, adjudication and disagreement state, claim-support denominators, rubric agreement within one band, role-specific metrics and critical flags. Zero observations produce null values with zero denominators, never default perfect scores. Two `Not observed` rubric labels are counted separately from ordinal agreement. Unsupported observed ratings are exposed. An incomplete run or missing reviews stays pending; critical flags produce blocked status. `--require-complete` returns a nonzero exit for pending; blocked always returns nonzero.

`reviewed` means that this recorded artifact has the required bound labels and adjudication. `qualification` remains `not-established` even then. Apply the team's approved release targets to actual sufficiently curated evidence, specialist reviews and pilot results separately. No software checkbox supplies independent experts or transforms developer fixtures into accepted holdout data.

All private input/output size, path, symlink, file-permission and exclusive-write rules in [acceptance-corpus.md](acceptance-corpus.md) apply: 32 MiB per artifact, regular UTF-8 JSON, private POSIX files/directories, no imported arbitrary host paths/commands, no overwrites, no learner API/staff console import. Keep consent/custody, journals, packets and annotations outside Git/deployment. The new modules/script are excluded from deployment context; the fixed five web evaluation dependencies remain unchanged.

The bridge is covered by hypothetical unit fixtures, existing development regression tests and mocked production HTTP adapters. Actual paid recording, expert blinding/adjudication, custody and private acceptance outcomes remain unqualified until the authorized team performs and records them.
