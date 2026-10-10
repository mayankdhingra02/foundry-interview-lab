# Three-level original preparation drafts

The runtime candidate catalog adds three separately versioned original packages. Their difficulty labels are editorial preparation targets; **expert calibration, learner pilot and independent content review remain pending**. Passing a reference implementation is not evidence that a task predicts interview performance.

| Package | Authored target | Substantive contract | Suggested preparation |
| --- | --- | --- | --- |
| `stock-foundations@1.0.0` | Junior, 30 min | In-memory counts, exact input types, caller-owned mapping isolation, unchanged rejected state; concurrency and persistence excluded | Trace conditionals; write boundary assertions |
| `stock-retries@1.0.0` | Mid-level, 45 min | SQLite persistence, exact request identity, durable success/denial replay, payload conflicts, stock/outcome transaction consistency; concurrent requests excluded | Error semantics, transactions and retry identity |
| `stock-lifecycle@1.0.0` | Senior, 60 min | Durable original outcome versus active/cancelled state, single restoration, concurrent retries/cancellations across independent connections, accounting invariant and operational limits | State modeling, transaction boundaries and concurrency verification |

These are new contracts, tests, rubrics and starters under `content/level-scenarios/`; they are not renamed versions of the original inventory task. Every package has public and protected suites, stage requirements, three criteria/probes/drills, hints and a reference. Each suite and total runtime remain within the existing execution policy: two suites, 10/20-second limits, 25-second run limit and 256 MiB. A learner's custom check remains additive under its separate execution policy.

## Compatibility and admission

`listScenarios()` deliberately remains the fixed five-task development benchmark corpus. Existing benchmark/evaluation counts must not silently expand when the practice catalog grows. `listPracticeScenarios()` combines that baseline with these three drafts; `getScenario()` resolves only exact allowlisted IDs and versions from that combined catalog. All five original hydrated package SHA-256 values are pinned in `tests/curriculum.test.ts`; no original manifest, source, rubric or frozen attempt is rewritten. Existing `Intermediate`/`Advanced` labels remain unchanged. The catalog filter maps those old labels to Mid-level/Senior for selection only.

The existing scenario/owner rollout policy still controls new admission. Production does not publish drafts just because their files exist: `PRACTICE_ADMITTED_SCENARIOS` must explicitly include their exact IDs, with the usual staff/invite/open policy. Development can display the candidate catalog; this is not a public-release approval. Retirement stops new attempts without changing package resolution or saved-attempt playback. Recommendations use the admitted catalog while saved criteria, history and drills retain their admitted versions.

The catalog offers an actual **Task level** filter. Opening a task displays its constraints, prerequisites and pending difficulty review. **Preparation goal level** is a learner goal recorded in configuration; changing it does not substitute a task, loosen its rubric or relabel its difficulty. No prerequisite checkbox or inferred skill score blocks access.

## Prerequisites and navigation

New manifests carry optional `familyId` and `curriculum` metadata:

```ts
{
  familyId: 'inventory-reservations',
  curriculum: {
    tier: 'Junior' | 'Mid-level' | 'Senior',
    calibration: 'unreviewed',
    constraints: string[],
    prerequisites: Array<{
      id: string; title: string; description: string;
      lesson?: { id: string; foundryPath: string }
    }>
  }
}
```

The server-only loader bounds metadata/assets and validates family, exact tier and prerequisite lesson ID/path pairs. A lesson reference is not an arbitrary URL. The prerequisite pairs are a subset of the existing source-verified Foundry lesson registry; tests cross-check both registries. Recommendations expose prerequisites and add an appropriate authored prerequisite lesson to the deterministic plan. The existing `withFoundryNavigation()` resolver supplies actual lesson URLs only with a reviewed `FOUNDRY_SITE_ORIGIN`. Without it, navigation is explicitly unavailable; the catalog displays readable preparation guidance without constructing links. Opening a lesson does not establish completion or mastery. Live destination availability/shared sign-in remain a separate integration gate.

## Family exposure

All three drafts and the original `inventory-reservations` share the stable family `inventory-reservations`. `scenarioFamilyId()` is a pure helper in `lib/interview-practice/curriculum.ts`; a static authored mapping also recognizes historical variants without optional fields. Known IDs cannot override their family through an unexpected field. Legacy unrelated packages default to their original scenario ID.

Session admission records a variant as repeated when that owner retains any same-family attempt. Progression conservatively infers repeats in chronological order and preserves already-recorded repeated flags. Same-family recommendations have `fresh:false`; a harder or easier variant cannot establish an unseen retest or add another fresh family to broader coverage. Rubric histories still retain their exact scenario/version/criterion and practice conditions: editorial transfer suggestions do not put different rubrics on an identical scale.

Exposure is based on saved account history, not global novelty. Deleted/off-platform exposure is unknown; this patch does not retain undisclosed content or family histories after deletion. A previously recorded repeated attempt stays repeated when an earlier attempt is deleted. Future attempts cannot prove global novelty from absent history. Family-level limitation text remains visible in the study plan.

## Qualification evidence and remaining gates

`tests/curriculum.test.ts` covers original digest preservation, metadata validation, safe DTOs, exact rollout selection, owner-scoped family admission, legacy mapping, same-family repeat recommendations and configured/unconfigured prerequisite navigation. `tests/e2e/curriculum.spec.ts` uses intercepted synthetic responses to check actual task filtering, goal/task separation, keyboard-readable prerequisites and narrow-layout behavior. These do not establish provider quality or real execution isolation.

Focused local verification on this patch: 101 deterministic tests passed across curriculum, progression, rollout, HTTP and Foundry navigation, with the nine real-runner cases skipped; TypeScript and owned-file lint passed. Eight intercepted browser contracts passed (four new curriculum cases plus four existing advisory-timing recovery cases), with narrow screenshots inspected. Original hydrated digest goldens remain exact. These results apply to the checked working tree; the focused commit/archive and CI must be verified independently.

`tests/level-content-docker.integration.test.ts` adds nine opt-in real-runner cases: each reference must pass both suites, each starter must fail a disclosed requirement, and each targeted broken approach must fail. The broken approaches admit booleans as stock counts, drop denied request identity, or restore cancelled stock repeatedly. The file requires `FOUNDRY_DOCKER_INTEGRATION=1` and the actual reviewed/provisioned `PYTHON_IMAGE_ID`; it uses existing `executeScenario()` and its pin, isolation, time/output limits and cleanup policy. It never pulls images or invokes host Python. All original real-runner cases stay unchanged. CI must explicitly include this new filename in its isolated-runner step.

No local Docker or live provider call was made for this work. An earlier author-owned host validation of these trusted generated assets observed 26 passing reference assertions and intended starter divergence; that is content-only evidence. Its added host-run test file was removed in favor of the real-runner qualification file. **The nine new container cases passed on commit `195a78d` in [fresh run 38004687852](https://github.com/mayankdhingra02/foundry-interview-lab/actions/runs/38004687852).** That run passed all four jobs, including 45 runner checks (26 real container cases including these nine) and 63 PostgreSQL cases. This qualifies their isolated execution path on that disposable CI head; it does not provide expert calibration or public-host security review.

Before broader rollout: independent experts must review contracts, prerequisite accuracy, rubric fairness and stated level differences; learners must pilot comprehension and timing; targeted mutants and unseen holdouts must be independently authored/reviewed; providers and operational deployment must meet their own release gates. These three related packages add practice breadth within one family, not three new unseen families or calibrated benchmarks.
