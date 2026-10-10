# Internal synthetic evaluation library

The **Evaluation** tab in `/internal` is a read-only view of the repository's curated developer-authored regression recipes. It supports inspection of scenario/condition provenance, recorded execution summaries, annotation status and label disagreements. It is not an evaluation run, annotation editor, acceptance holdout or source of expert-approved examples.

## Current evidence

The current repository contains 17 synthetic recipes, matching captured isolated execution facts for the ten original starter/reference snapshots, a blank human-review template, and no recorded model candidate set. Every displayed example therefore says **Human review pending**, its disagreement count is unknown, and example approval remains pending. A missing disagreement count is represented as `null`; it never becomes zero. The source file's developer curation is not human expert approval.

The existing `HumanAnnotations` format records independent-review attestations and adjudication, but contains no example-approval field. Even complete annotations cannot manufacture an approval decision. Before calling a future example approved, establish a separate documented human content/quality approval workflow and extend the artifact contract deliberately. This implementation keeps that product requirement visibly partial.

## Source and privacy boundaries

`lib/server/evaluation-library.ts` statically imports four fixed repository assets: `attempts.json`, `runtime-observations.json`, `human-review.template.json` and `baseline-summary.json`. An explicit server allowlist identifies the 17 curated recipe IDs. Unknown/duplicated recipes, mismatched benchmark identities and stale captured scenario/snapshot/suite digests fail validation. New fixture families require a reviewed allowlist/source change. The library does not call a model, rerun code, read `PracticeStore`, initialize billing, inspect support records, accept an upload, or resolve caller-provided paths.

The API projects only published task briefs and rubric anchors, developer-authored synthetic dialogue/review focus, scenario/version/condition, captured run status and aggregate suite counts, immutable context/runtime digests, and annotation/artifact metadata. The old-snapshot and unexecuted conditions remain explicit. Synthetic dialogue, including prompt injection, is displayed as quoted text and never interpreted as instructions or HTML.

Code files, reference solutions, test sources and identities/titles, raw runtime output, execution commands, model response text, provider response IDs, reviewer IDs, human notes, private support records and saved learner data are excluded. Disagreements expose anchored levels or boolean audit labels, not quoted claim text. Protected author material remains behind the existing purposeful **Scenario author preview** action. Evaluation GETs do not grant that access.

`GET /api/internal/evaluations` returns list metadata and qualification prerequisites. `GET /api/internal/evaluations/<known-id>` returns the projected example. Both require the server-verified actor and the existing exact `ADMIN_USER_IDS` staff policy on every request. Local identities remain forbidden in production. Responses use `Cache-Control: private, no-store`. Query parameters that attempt to select a different source are rejected. Writes and arbitrary actions are rejected. The evaluation branch dispatches before initializing the review/practice service, so storage or payment configuration is not needed to inspect repository fixtures. The surrounding staff console retains its separate support-tool behavior.

## Reviewed artifacts and disagreement interpretation

`buildEvaluationRepository` accepts the existing `CandidateSet` and `HumanAnnotations` formats as an internal code interface, not an HTTP upload interface. It reuses the benchmark's schema, evidence/context binding, guarded output validation, complete criterion coverage, distinct reviewer checks and adjudication chronology. Matching candidate digests are required before any review labels are attributed. Edited outputs, stale contexts or mismatched candidate digests do not inherit old labels.

Two bound distinct reviewer records permit a label-difference display; missing labels remain missing. Complete valid adjudication records show the adjudicated levels/flags beside each disagreement. An incomplete pair or adjudication remains pending/partial. Reviewer identity and independence attestations still need the actual human review process. Imported metadata cannot independently establish that a provider generated a response.

The production repository loader currently passes no candidate set and the blank annotation template. To expose future synthetic reviewed artifacts, complete the existing offline review workflow in [evaluation.md](evaluation.md), verify their synthetic provenance and absence of private material, and make an explicit reviewed code change importing those fixed assets. Do not point this library at learner exports, support cases, environment-controlled paths, arbitrary uploads or private operational workspaces. No annotation or approval is added by this feature.

Qualification uses the existing release-gate calculator and clearly identifies the stored deterministic baseline timestamp. Opening the screen does not rerun those regressions or qualify a model. The 40-attempt minimum, recorded provider candidates, independent expert adjudication, operational/security/accessibility review and learner pilot remain separate release obligations.

## Verification

`tests/evaluation-library.test.ts` checks current pending status, sparse/injection/unexecuted/stale conditions, protected-material projection, matching hypothetical artifact formats, disagreement mechanics, missing/duplicate reviewers, changed candidate/context rejection and source validation. Hypothetical unit records stay in test memory; they are never saved as human annotations or provider output.

`tests/evaluation-api.test.ts` checks anonymous/ordinary/near-match/local-production denial, exact allowlist revocation, private caching headers, fixed sources, read-only routes, and absence of practice-service initialization. `tests/e2e/evaluation.spec.ts` uses explicitly synthetic frontend contract fixtures for pending labels, escaped injection text, unknown disagreements, filter behavior, keyboard tabs, mobile overflow, access revocation and denied-fetch behavior. These fixtures establish interface behavior; they do not establish hosted authentication, real expert approval or live AI quality.
