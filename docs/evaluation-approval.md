# Recorded approval for fixed synthetic evaluation examples

The staff Evaluation library can import a private, operator-provisioned review bundle for the 21 fixed developer-authored synthetic recipes. This completes the ability to represent a real display-approval decision and inspect its validated coach report/interviewer proposal. **No actual approvals, provider candidates or completed human judgments are supplied by this change.** The default library remains pending. It is not an acceptance corpus or learner-data importer.

Display approval and AI qualification answer different questions. An approved teaching example may demonstrate unsupported feedback or an irrelevant question; the existing model-quality gate can remain blocked. Adjudication alone never grants display approval. A safe status badge never permits retaining the raw output after approval becomes invalid.

## Source and trust boundary

Recipes, runtime captures and deterministic baseline remain the fixed checked-in assets. HTTP callers cannot choose another source, upload a bundle or write approvals. Every list/detail request first verifies the existing exact staff account policy. It then rereads the runtime file and current reviewer policy; no approval result is cached. No practice/support store is opened.

The bundle uses the existing `CandidateSet` and `HumanAnnotations` schemas, limited to known fixed synthetic case IDs, plus explicit approval records. It cannot contain another corpus, a learner export, arbitrary scenario package, custom upload or replacement runtime capture. Strict envelope/record schemas reject extra fields. File size is capped at 2,000,000 bytes and cases/approvals at 60.

An operator controls the file, its pin and the authorized reviewer list. This is a trusted offline import, **not cryptographic verification of a human identity or proof that a provider produced an output**. The owner must verify reviewer identity/independence, synthetic provenance, rights and privacy before installation. Do not add learner attempts, private acceptance/holdout data, notes from support cases or secrets to this library. Human content/privacy approval is not permission to reuse learner data for research or training.

## Private runtime configuration

Leave all three variables unset by default:

```text
EVALUATION_REVIEW_BUNDLE_PATH=/absolute/private/runtime-mount/review.json
EVALUATION_REVIEW_BUNDLE_SHA256=<SHA-256 of the exact file bytes>
EVALUATION_REVIEWER_IDS=<exact comma-separated recognized reviewer/adjudicator/approver IDs>
```

The path must be absolute, outside the application working directory and every Git tree. Every component must be nonsymbolic. The file must be regular, single-link, mode `0600` or stricter, with an immediate parent directory mode `0700` or stricter. It must be owned/readable appropriately for the unprivileged runtime account. Use canonical paths, including `/private/...` on macOS when `/tmp` or `/var` is a symlink. File identity/size is checked around bounded reading; the SHA-256 pin must match the exact bytes. Missing, malformed, partially configured or changed files return a generic private `503` with no path or content in the response.

Provision a private runtime mount separately from the build context and image. Do not copy the artifact under `public/`, `evals/`, `.next`, the source checkout or an image layer. The artifact is not statically imported or selected by request input. The existing Docker allowlist still includes only the four fixed development assets. This patch does not provision a mount, credentials or hosted policy. Treat the mounted file, configuration and operator access as private operational assets.

## Preparing and recording a decision

Use the existing offline paired benchmark recording/review workflow in [evaluation.md](evaluation.md) for these fixed synthetic recipes. Do not substitute the separate private-corpus role formats. After actual provider output and independent review have been collected, the side-effect-free `prepareEvaluationReviewBundle(candidates, annotations)` helper in `lib/server/evaluation-library.ts` returns:

- `bundle`: the parsed candidates/annotations and current source digests, with `approvals: []`;
- `bindings`: exact per-case bindings only where guarded candidate validation and complete paired adjudication succeeded.

The helper makes no file, model, execution or approval call. Run server-only tooling with the existing `--conditions=react-server --import tsx` convention. Keep inputs/results private and outside Git. Its bindings are preparation metadata, not approval templates with preselected decisions or human attestations.

An authorized content reviewer must independently decide whether each example is suitable for staff display. Add a record to `bundle.approvals` only after that decision:

| Field | Required meaning |
| --- | --- |
| `binding` | Exact helper-produced binding for this case and these unchanged artifacts. |
| `decision` | Explicit `approved`, or `revoked` to remove previously authorized display. |
| `decidedBy` | A verified reviewer identity present in the server-configured exact allowlist. |
| `decidedAt` | Actual decision time; no future timestamp and no earlier than adjudication. |
| `expiresAt` | Chosen validity deadline later than the decision. Expired display is rejected. |
| `scope` | Exactly `fixed-synthetic-staff-display`. |
| `attestations` | Explicit `syntheticOnly`, `contentQualityReviewed`, `privacyReviewed`, `displayApproved`, all `true` only when honestly established. |

The approval binds benchmark version, exact recipe, loaded scenario/package/version, rubric version, fixture, execution context/capture, evidence context, model/prompt-bearing candidate, complete annotation and whole review-artifact digests. The outer bundle also binds recipes, captures and baseline. The file pin binds the approval itself. The candidate rubric version must equal the loaded package version. Both independent reviewers, adjudicator and decision-maker must still be recognized by the current server policy. Reviewer identity/independence remain human obligations; merely listing an ID does not establish them.

Persist a reviewed bundle securely, calculate its exact byte pin, and install file/pin/policy together. A transition mismatch safely returns `503`; it never falls back to exposing old approved output. Do not copy approvals after changing a model, prompt, response, review, scenario, capture or recipe. Re-prepare bindings and conduct the affected review again. Adding another candidate/review changes the whole review-artifact digest and invalidates prior bindings conservatively.

## Revocation and display

Replace the relevant record with `decision: 'revoked'` and its actual authorized decision time, retaining the original binding and historical attestations; update the file pin. Alternatively remove a recognized reviewer from current policy or remove the approval record to stop display. Revocation, expiry, unknown identities, stale bindings and incomplete review omit the report/proposal entirely on the next request. Invalid whole-source bindings, duplicate/unknown records or invalid files reject the configured library. Removing all three configuration values returns to the pending fixed library.

The deployment owner controls rollback protection: retain the current pin/policy in the secret/config manager and audit changes. The file format cannot detect an operator deliberately reinstalling an old still-valid approval and its old pin. A response already legitimately viewed or copied by staff cannot be revoked retroactively. The screen refreshes on explicit Refresh examples; already displayed text is not continuously erased without a new request.

Only an approved example projects bounded validated report/proposal text and immutable evidence IDs/kinds/digests with snapshot/run/turn identifiers. Rendering uses escaped React text, with no HTML/Markdown execution, arbitrary links or edit controls. Raw code, protected checks, runtime output/commands, provider response IDs, reviewer/adjudicator identities, private human notes and file paths remain excluded. The existing purposeful author-preview action remains separate. The public repository still exposes its checked-in author assets; this app boundary does not restore source confidentiality.

## Validation and remaining qualification

Focused unit/API tests use clearly hypothetical in-memory records and private temporary files. They cover exact binding, recognized identities, expiry/revocation, incomplete review, source substitution, file pin/perms/link/Git boundaries, auth before file access, output omission and display-approved bad output retaining a blocked model gate. A rendering test checks escaped candidate text. Browser contract tests cover approval filtering, keyboard focus, mobile overflow, revoked/unavailable refresh and removal of previously displayed content.

These tests establish software mechanics. They do not supply a real reviewer approval, human-independent annotation, actual model-quality result, protected holdout, deployment qualification or pilot. The browser suite must run against a server containing this patch; no new devserver or live provider was started during its isolated implementation.
