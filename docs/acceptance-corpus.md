# Private acceptance corpus tooling

`scripts/acceptance-corpus.ts` validates operator-supplied private development, acceptance and holdout manifests. It can export faithfully reconstructed evidence contexts or, with explicit opt-in, record isolated snapshot executions. Its default is no action. It has no model-inference or expert-label generation option.

This supplies data preparation and provenance checks. It does **not** supply the design's proposed 40–60 genuinely curated attempts, two independent expert reviews, protected holdout custody, learner pilot, or release approval. Those remain pending. The 21 checked-in development recipes and their existing observation records remain unchanged; private inputs never replace them.

## Start with a blank private manifest

Use Node 24 from the repository root. These commands are recipes, not records that they were run against a real acceptance corpus. Replace the absolute private paths and opaque operator identifiers. Keep private artifacts outside the repository and deployment context.

```sh
node --conditions=react-server --import=tsx scripts/acceptance-corpus.ts

node --conditions=react-server --import=tsx scripts/acceptance-corpus.ts \
  --template --split acceptance --id team-acceptance --version 1.0.0 \
  --custodian content-owner --output /absolute/private/corpus/acceptance.json
```

The template has zero cases and `sealedFromPromptDevelopment: false`. It contains no captures, labels, adjudication or approval. An empty template validates as pending; adding acceptance/holdout cases requires an explicit true custody attestation and `usedForPromptDevelopment: false` on every source. This attestation is an operator claim, not independent verification. Do not mark development material as held out by renaming it.

## Populate and validate

The strict schemas and exported TypeScript types live in `evals/private-corpus.ts`. Unknown keys and schema versions are rejected. Supply JSON values directly; manifests cannot reference a host source file, command, image-pull instruction, URL or arbitrary repository path.

| Field | Required meaning |
| --- | --- |
| `corpus` | Opaque ID, semantic version and exactly one split: `development`, `acceptance`, or `holdout`. |
| `source` | Either `operator-authored-synthetic` or `consented-deidentified-attempt`; opaque source/preparer IDs, preparation time, prompt-development exposure and `deidentified-no-credentials-no-raw-audio` attestation. Consented material additionally requires an opaque permission reference and original source-artifact SHA-256 digest. Actual consent evidence stays under the team's separate access controls. |
| Scenario and rubric | Exact published scenario ID/version, `digest(scenario)`, rubric version equal to the scenario version, and `digest(scenario.rubric)`. Retired published versions remain resolvable for saved material. |
| `fixtureVersion` | Semantic version of this prepared case representation. Increase it when preparing a changed case. |
| `runtime` | Version 1 binding with scenario image family, approved image alias and immutable `sha256:` image ID. Import validates the binding's structure/family; it does not prove that the operator ran that image. Actual capture additionally requires the configured runner binding to match exactly. |
| `snapshot` | Semantic version, original timestamp, full learner file contents and `digest(files)`. Only paths accepted by the published scenario workspace policy are allowed. |
| `conditions` | Mode, fresh/repeated exposure, role, level, skills, AI availability, opened hints, original/current advisory target and timestamped extensions; typed timing and written-participation choices. Current target must equal original target plus recorded extensions. |
| Attempt content | Original start/end times, ordered typed/corrected/transcribed learner and authored/model interviewer turns, optional valid earlier opposite-role reply references, and assistant messages. Authored competency IDs must belong to the scenario rubric. Text is data, never instructions to the tool. |
| `condition` | Descriptive sampling label such as `partial`, `interrupted` or `alternative-candidate`; it is not an expert score or assertion of correctness. |
| `execution` | Exactly `unexecuted`, `declared-interruption` with an allowed phase/reason, or `captured` with an exact capture digest. |
| `reviewFocus` | Bounded operator notes about what reviewers should inspect, without expert outcomes. |

`digest` is the repository's canonical object digest from `lib/interview-practice/domain.ts`, not a checksum of a pretty-printed JSON file. Do not copy an existing digest to changed bytes. Preparation must occur after the represented attempt, and manifest creation after preparation. Snapshot, conversation and extension timestamps must be inside the represented attempt. A written-only choice is recorded as a condition, never a weakness.

The current format represents **one exact final snapshot** plus dialogue and assistant messages. It does not infer edit history, accepted/rejected edit proposals, multiple earlier run snapshots, voice recordings, or learner-authored check execution. Those unsupported fields are rejected rather than reconstructed. Keep their source evidence separately until a versioned schema supports them. The public scenario context omits reference solutions and protected test source; an export still contains private attempt content and must remain private.

```sh
node --conditions=react-server --import=tsx scripts/acceptance-corpus.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --compare-corpus /absolute/private/corpus/development.json,/absolute/private/corpus/holdout.json
```

Validation prints counts, opaque corpus identity, scenario/condition/source coverage and pending status; it never prints learner code, dialogue, raw test output or file paths. An optional `--output NEW_PRIVATE_JSON` saves that summary exclusively. Errors use a fixed content-free diagnostic.

The loader checks overlap against all 21 checked-in development cases and each explicitly supplied comparison corpus. It rejects cross-split reuse of a case ID, source ID or identical scenario/file/dialogue/assistant content despite changed IDs, timestamps or conditions. Duplicate content/source IDs inside one private corpus are also rejected. The lower-level synchronous schema functions only check indexes explicitly supplied to them; use `loadPrivateCorpus` or the CLI for the checked-in development comparison.

This cannot detect every paraphrase, undisclosed source or previously exposed artifact. The custodian must supply every relevant comparison corpus, restrict acceptance/holdout access, record exposure and avoid using those cases for prompt development. A successful overlap check is not a claim of independent holdout custody.

## Import exact execution observations

Capture files use `schemaVersion: 1`, `provenance: private-corpus-captures` and a bounded `captures` array. Each record requires:

- Exact corpus ID/version/split, case ID, pre-execution input-context digest, scenario/rubric/fixture versions and digests, snapshot version/digest, authored test-suite digest and immutable runtime binding.
- `provenance: operator-supplied-isolated-runner-record`, an opaque operator ID and ordered start/completion/recording times.
- `executionOrigin: recorded-attempt-run` for an original run after that snapshot's creation and before the original attempt ends, or `offline-snapshot-replay` for a later execution beginning at or after the original attempt ends. A replay never becomes an original learner run.
- The existing runner's fixed command identity, bounded output, actual run status, exit code, duration, runtime digest and test observations with exact authored IDs/titles in execution order. Completed runs require every authored suite; interrupted infrastructure/timeout runs may contain only an ordered prefix and a null exit code.

The pre-execution input-context digest excludes the execution discriminator to avoid a circular capture checksum. Final case/context digests additionally bind the selected capture, execution origin, frozen evidence and freeze time. Unknown provenance, origin, test IDs, commands, versions, stale context, duplicate case captures and missing selected observations fail closed. A digest binds the record's bytes; it does not cryptographically attest that an external operator really executed them.

```sh
node --conditions=react-server --import=tsx scripts/acceptance-corpus.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json
```

Select an observation explicitly by setting that case's `execution` to `{ "kind": "captured", "captureDigest": "<privateCaptureDigest(record)>" }` in a new operator-managed manifest version. The tool never selects a capture by a broad starter/reference variant and never edits the manifest. Recalculate capture bindings when the corpus identity/version or prepared case inputs change. Do not repurpose an old capture for a modified input.

A declaration of disconnect, timeout or restart without an actual capture remains unobserved: it contributes zero test observations. Supplied but unselected records do not change that. A captured timeout preserves only the actual preceding observations and supplies no invented result for the remaining suite.

## Explicit isolated capture

**Do not run this recipe on a shared learner execution host.** It requires a dedicated, qualified isolation host, an already available allowlisted image, a matching configured immutable runner binding and normal runner admission. It neither pulls images nor selects execution commands from the manifest.

```sh
FOUNDRY_ACCEPTANCE_CAPTURE=1 \
node --conditions=react-server --import=tsx scripts/acceptance-corpus.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --capture-docker --acknowledge-isolated-host --operator content-owner \
  --cases private-attempt-01,private-attempt-02 \
  --output /absolute/private/corpus/new-capture-batch
```

Both the environment gate and explicit isolated-host acknowledgment are mandatory; missing gates produce no output directory or execution. A batch contains at most ten distinct known cases that are not already selected as captured. The runner receives only the immutable prepared files, server-selected authored public/protected suites, the exact configured runtime binding and cancellation signal. It retains the existing no-mount/no-network/container-resource limits; learner code never runs on the host. SIGINT/SIGTERM passes cancellation to that runner. Its existing cleanup/admission rules still apply.

The output directory must be new. An empty `checkpoint-000.json` is written before execution, then a new cumulative checkpoint after every accepted result and a final `captures.json` after completion. Each write is exclusive and synchronized. A cancelled or rejected batch leaves its already completed checkpoints; it does not synthesize a result for an interrupted/unbound execution. Import **one latest cumulative checkpoint or the final file**, not all checkpoints together. Later batches use a new directory; up to ten separate capture files may be imported, with no duplicate case records.

The capture entry point has mocked-executor unit coverage. It has not been exercised with Docker as part of this patch; it needs an explicitly authorized qualification run on the dedicated host or disposable CI. Existing runner qualification does not automatically qualify this new capture journal path. No actual private corpus, provider call, human review or release outcome was generated during development of this tooling.

## Context export and current bridge limit

```sh
node --conditions=react-server --import=tsx scripts/acceptance-corpus.ts \
  --corpus /absolute/private/corpus/acceptance.json \
  --captures /absolute/private/corpus/captures.json \
  --export-contexts --output /absolute/private/corpus/contexts-v1.json
```

Export revalidates the manifest and capture set and materializes contexts itself; it does not accept externally assembled session objects. Each case retains corpus/split, case/input/final-context digests, source, sampling condition, versioned scenario/rubric/runtime identities, original file/dialogue/assistant content, recorded timing conditions and explicitly observed execution. The generated session is an evaluation reconstruction, not an imported saved learner attempt: it has no synthetic jobs, usage charges, edit proposals, reports or mutation events. Reviews are `[]`, adjudication is `null`, and qualification remains `pending`.

**Private-split import into the existing role recorder/reviewer is currently unsupported.** Its `development-regression` corpus/context contract is intentionally unchanged. The export carries `existingRoleWorkflow.status: unsupported`; do not cast it to a legacy attempt, relabel it as development, or treat it as completed acceptance evaluation. A future bridge must bind the private corpus/split and exact context into recording, per-role review and adjudication, preserve custody, and supply actual independent reviewers. See [model-benchmark.md](model-benchmark.md) and [role-review.md](role-review.md) for the existing development workflow.

## Storage and operational limits

Inputs are regular UTF-8 JSON files, at most 32 MiB each. A manifest has at most 100 cases; combined capture imports have at most 100 records. Each case has at most 40 dialogue turns, 40 assistant messages, 20 skills/focus notes and 12 bounded timing extensions. Existing workspace file limits apply. Captures have at most eight authored suite observations and a 120-second wall-time/duration ceiling; stdout/stderr are each limited to 64,000 UTF-8 bytes. There are at most ten comparison files and ten capture files per load. CLI summaries carry no execution results or quality denominators.

On the supported POSIX macOS/Linux operator host, files and their immediate directory must have no group/other permissions. New artifacts use `0600`; new directories use `0700`. The reader rejects a symlink in any path component, directories as files, changed file identity/size, invalid UTF-8 and excessive input. Outputs never overwrite an existing file; new capture directories must not exist. Symlinked output ancestors are rejected before creating their descendants. Use real absolute paths rather than a symlinked private-directory alias.

These checks assume a trusted, access-controlled operator host. They do not provide encrypted storage, owner authentication, protection against a hostile privileged process swapping directories, or Windows ACL qualification. Keep corpus copies, captures, exports, consent evidence and human annotations in the team's approved private storage with separate reviewer/custodian access. They are not learner API, staff-console or production-worker imports. The offline script and module are excluded from deployment context; the fixed five evaluation dependencies needed by the web build are unchanged.

For problems, inspect the manifest privately against the strict schema and pinned local package, write corrected data to a new artifact/version, and validate again. Never loosen a digest, invent an execution success or add approval labels to make validation pass.
