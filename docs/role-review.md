# Role-specific independent review

`evals/role-review.ts` scores imported human assessments of the controlled model harness's interviewer, coach and assistant ask/plan/edit outputs. It uses a new strict artifact format. The original paired `CandidateSet`, annotation schema and release gate in `evals/benchmark.ts` stay unchanged. The earlier `benchmark-models.ts --review-template` produces its original blank handoff format; use the separate commands below for the role-specific scoring format.

This workflow makes no provider, billing, runtime or public-host call. It does not execute a proposed assistant patch. No actual provider output or human review was collected while implementing it; hypothetical labels exist only in unit tests. Existing repository examples and release qualification remain pending.

## Prepare a blank template

Use an existing private role-run journal from the controlled harness:

```sh
node --conditions=react-server --import tsx scripts/review-role-models.ts --run work/model-review/baseline.json --template --output work/model-review/role-review.template.json
```

This is an operator recipe, not evidence that a recording exists. It creates an exclusive `0600` JSON file; new parent directories use `0700`. Existing outputs are never overwritten. The operator must ensure existing parent directories and storage are private. Inputs must be regular JSON files of at most 64 MiB. There is no record, retry, resume, paid-call or code-execution option. `.env.local` is not read implicitly.

Templates include only validated candidate entries, with empty `reviews` and `adjudication: null`. No default label, reviewer, judgment or approval is filled in. Every row binds the candidate entry digest, exact task context, scenario version/digest, rubric version and evidence digest. The envelope binds the full run-artifact digest, run ID, benchmark version/digest, prompt version and development-corpus designation. Editing a run, candidate, context or version invalidates the old binding. Regenerate a blank template and conduct the affected review again; do not copy old labels automatically.

The importer reuses `validateRoleRun` for structural, accounting and provenance checks, then `createRoleContexts` to reconstruct the current authored case/role contexts. This pure helper does not read provider credentials, current pricing or output-token configuration. An unrelated provider configuration change cannot prevent offline review. Recorded prices remain provenance metadata, not an independently reconciled invoice. Candidate reports/questions/file patches are checked against the same evidence and task policies before accepting labels.

## Independent labels and adjudication

Two experienced reviewers inspect each actual candidate independently before seeing the other's judgments. Each `reviews` row contains a pseudonymous `reviewerId`, `independent: true`, ISO UTC `completedAt`, and `labels`. Complete `adjudication` only afterward, with `adjudicatorId`, the exact pair of `reviewerIds`, a later `completedAt`, and resolved `labels`. Reviewer identities are compared after trimming and case normalization. The importer rejects duplicate identities, non-independent attestations, reviews predating candidate completion, adjudication predating either review, or an adjudication naming a different pair. The run journal must precede its inference timestamps.

Every role's labels include:

- `claimAuditComplete`: an attestation that all substantive factual claims were inspected.
- `noSubstantiveClaims`: an explicit claimless-output attestation. It must accompany an empty `claims` array; an empty array without that attestation remains incomplete.
- `claims`: distinct stable IDs, each with `support` of `supported`, `unsupported` or `not-observed`, plus `fabricatedExecution` and `criticalSolutionLeak` booleans. Claim IDs should identify the same actual statements across reviews. Adjudication must cover the union of independently identified claims.
- `fabricatedExecution` and `criticalSolutionLeak`: output-level booleans, or `null` when unreviewed. Null is missing information, not a negative flag.
- `notes`: supporting reasoning and artifact references, limited to 6,000 characters. Notes are retained in the private annotation input, not copied into the aggregate score report.

Role-specific fields are discriminated and mandatory:

| Role | Labels | Meaning |
|---|---|---|
| Coach | `kind: "coach"`, `rubric: [{criterionId, level}]` | Independently assign every authored criterion an anchored `Strong`, `Developing`, `Needs work` or `Not observed` label. Inspect citations, uncertainty and concrete advice during the claim audit. Unknown or duplicate criteria are rejected; incomplete coverage stays pending. |
| Interviewer | `kind: "interviewer"`, `relevance`, `policyCompliance` | Judge whether the question or ending action fits the actual stage, evidence, required coverage, premise and assistance boundaries. Each field is `pass`, `fail` or `not-observed`. |
| Assistant ask | `kind: "assistant"`, `mode: "ask"`, `usefulness`, `requestCompliance`, `policyCompliance`, `correctness`, `correctnessBasis` | Assess the explanation's usefulness, satisfaction of the recorded request, permitted help/file behavior and technical accuracy. |
| Assistant plan | Same fields, `mode: "plan"` | Assess whether the proposed steps fit the current code and requirements, are feasible, and respect the requested assistance policy. |
| Assistant edit | Same fields, `mode: "edit"` | Assess the proposed patch and explanation against the request, disclosed requirements and edit boundaries. A well-formed patch is not proof of a passing implementation. |

Assistant verdicts also use `pass`, `fail` or `not-observed`. `correctnessBasis` is `static-review` or `not-observed`; the format deliberately cannot claim that a proposed patch was executed. Actual patch correctness needs a separately recorded run in the qualified sandbox and independent review of its exact file/suite identity. An ask/plan candidate cannot change files, and an edit cannot change paths outside the published workspace.

Incomplete labels, unaudited claims, missing observations, missing reviewers or unresolved adjudication remain pending. A `Not observed` coach criterion is a valid missing-observation judgment; it is never converted into a weakness or ordinal band. If both the coach and experts leave every criterion unobserved, rubric agreement is unknown and that case stays pending for quality scoring.

Any fabricated execution or critical solution leak flagged by a bound reviewer or adjudication blocks the result, even if another reviewer or adjudicator disagrees. The report exposes the disagreement rather than averaging the critical flag away. A mistaken flag needs a deliberate corrected human artifact and audit process. Metadata cannot verify reviewer identity, actual independence or expert truth; the team's human process must establish those facts.

## Score an imported review

```sh
node --conditions=react-server --import tsx scripts/review-role-models.ts --run work/model-review/baseline.json --reviews work/model-review/role-review.completed.json --output work/model-review/role-score.json
```

The command reports `pending`, `blocked` or `reviewed`. `reviewed` means the selected development tasks have complete usable independent review; it is not a model release or example approval. `qualification` always remains `not-established`. A critical flag exits nonzero. Pending normally exits zero for inspection; add `--require-complete` to make pending exit nonzero. Invalid inputs and conflicting output paths exit nonzero without printing input contents. Without `--output`, scoring prints aggregate metadata and counts, not model output, reviewer IDs or notes.

Coverage is reported per role and scenario: planned, attempted, validated, adjudicated, usable reviewed, pending, and rejected/incomplete task counts. Unselected roles have zero coverage. Rejected, missing, reserved or uncertain outputs never enter quality denominators and cannot receive reviews. A partial/stopped run stays pending even if some validated entries were reviewed. Role/case keys are unique; incomplete grids or self-consistent hashes that do not match the authored contexts are rejected.

All quality metrics show numerator, denominator and `value`; zero denominators produce `null`. Metrics use complete adjudicated labels only:

- Claim support counts audited supported claims over audited claims separately for each role/mode. A deliberately claimless question has no claim-support score, even when its relevance was reviewed.
- Coach rubric agreement counts comparisons within one anchored ordinal band. Pairs where both sides are `Not observed` are excluded and counted separately. A model rating when the expert says `Not observed`, or an observed expert rating when the model says `Not observed`, is a disagreement. Unsupported observed model ratings have an explicit count.
- Interviewer relevance and policy compliance count reviewed passes over their reviewed tasks.
- Each assistant mode reports usefulness, request compliance, policy compliance and static correctness separately.
- Critical flags count affected case/role tasks rather than multiplying one incident by the number of reviewers.

No thresholds are silently invented for assistant usefulness or correctness. Apply the team's explicitly approved acceptance targets to appropriate held-out evidence later. These metrics do not establish a protected acceptance holdout, sufficient task-family breadth, fairness, accessibility, live account qualification, pilot learning improvement, or readiness for public deployment. Review the proposed coach/interviewer targets and separate release obligations in [evaluation.md](evaluation.md). No foundation-model training or automatic expert-label generation is needed.

## Verification

`tests/role-review.test.ts` uses only hypothetical in-memory candidates/reviewers and temporary private CLI files. It verifies blank templates, exact artifact/version/context bindings, independent review and chronology, role/mode separation, partial labels, zero denominators, claim-union adjudication, rubric missing-observation handling, critical blockers, coverage, invalid provider-config independence and exclusive zero-call CLI behavior. Existing `tests/role-runner.test.ts` continues to verify recording behavior. Deployment-context tests keep the new operator script and review module outside the web build while preserving the same five fixed evaluation source dependencies.
