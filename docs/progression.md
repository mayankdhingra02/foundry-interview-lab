# Evidence-based practice progression

`lib/interview-practice/progression.ts` implements deterministic recommendations from completed, evidence-linked practice reports. It makes no model calls, needs no embeddings or training data, and does not produce a mastery score, hiring recommendation, or interview pass probability. This is an initial editorial policy; its thresholds and transfer mappings still need content-owner review and learner evaluation.

## Integration contract

```ts
buildProgression(
  sessions: SessionView[],
  catalog: PublicScenario[],
  goals?: { selectedCompetencies?: string[] },
): ProgressionResult
```

Pass only the authenticated learner's authorized session views. The function does not perform authentication, fetch records, persist a plan, or validate arbitrary HTTP input. `GET /api/interview-practice/progress` supplies owned sessions and accepts up to 20 repeated `competency` query parameters, each at most 100 characters. The HTTP boundary accepts exact authored rubric IDs from the public catalog or the actor's saved attempts, including retired criteria. Unknown IDs and internal transfer aliases such as `verification` return 400; aliases remain an implementation detail of the pure recommendation policy. Duplicate valid selections are normalized. Responses are private and never cached.

The existing `/progress` response remains compatible:

- `skills`: `id`, `name`, `observations`, `lastObservedAt`, `level`, and `levels` retain their names and types. `levels` contains all four rubric labels; `Not observed` is always zero here because it is not an assessed finding.
- `recommendations`: `scenarioId`, `title`, `fresh`, and `reason` retain their names and types. The list still contains the available catalog tasks, with duplicates by scenario ID collapsed to the latest supplied version.
- Additional skill fields expose evidence counts, fresh/repeated counts, actual help received, individual observation provenance, and comparison groups.
- `studyPlan` adds at most three concrete steps, selected competencies, limitations, verified Foundry lesson references, and `policyVersion: deterministic-v1`.
- `details` exposes attempt/report counts, excluded finding counts, missing observations, unresolved goals, missing fresh-task coverage, and the explicit evidence policy.

The API now replaces its earlier inline aggregation with:

```ts
return privateJson(buildProgression(
  await service.listSessions(actor.id),
  listScenarios().map(toPublicScenario),
));
```

The progress UI renders `studyPlan.steps`, each skill's history, evidence counts, observation dates, assessment sources, familiarity and assistance conditions. Optional exact-criterion goals are stored in the page URL. Invalid bookmarked goals have a clear reset path. A drill step includes its complete authored lesson/exercise; its link opens the original attempt rather than claiming that a particular drill already has an individual page. Its completed flag remains a learner self-report. Foundry lesson paths remain plain source references until navigation is integrated.

## What counts as an observation

Only completed attempts with a published report contribute findings. Each attempt contributes at most one finding per rubric criterion, using only its latest published report. Published array order is authoritative: approved corrections supersede earlier reports even if report timestamps differ. Multiple report generations do not become multiple learner attempts.

The criterion must exist in that attempt's original stored scenario. A finding other than `Not observed` needs at least one distinct evidence reference, and every reference must exist in the selected report's evidence. Unknown criteria, missing references, duplicate references, and duplicate criteria are excluded and counted in `details.ignoredFindings`. These structural checks establish traceability; they do not establish that a report's interpretation is semantically correct. The existing report validator and human review remain necessary.

`Not observed` contributes only to `details.unobserved`. It does not lower a skill finding or introduce a weakness. A correction from `Needs work` to `Not observed` removes the superseded negative assessment from that attempt. An older valid finding from a different attempt remains in history, with its original date, when a subsequent attempt does not observe that criterion.

An observation date is the original frozen-evidence timestamp, falling back to the recorded final-submission event, then the first report's timestamp for older fixtures. Support actions, corrections, and drill completion do not advance the observation date. The latest valid observation determines the compatible `skill.level`; ordinal finding labels are never averaged into a numeric score.

`observations` counts attempts with valid findings. `evidenceCount` counts distinct cited evidence IDs within each attempt. The same test cited by three criteria contributes one item to the overall evidence count, and one to each applicable skill's count. The same evidence ID string appearing in two distinct attempts counts twice because those are separate observations. Neither count measures evidence quality or independent causal proof.

If duplicate session views are supplied, a session ID is counted once using the greatest revision and then the latest administrative timestamp. Callers should supply a consistent authorized store snapshot; conflicting copies with identical revisions and timestamps are not a supported synchronization mechanism.

## Freshness and conditions

Any saved attempt makes that scenario seen, including unfinished attempts. Changing the scenario version does not make a previously seen scenario fresh. Stored `promptExposure: repeated` is preserved even when the earlier attempt has been deleted. If supplied history reveals an earlier attempt at the same scenario, a later incorrectly fresh record is conservatively treated as repeated.

Every observation records practice/simulation mode, whether AI help was allowed, assistant requests and responses, accepted edits, hints opened, actual help received, and the number of configured accommodations. AI permission alone is not help received. A failed or unanswered request is recorded as a request without claiming that assistance was delivered. A response, accepted edit, or opened hint records received help.

Help does not reduce a level, change its evidence count, or penalize task ranking. Accommodations are recorded without grading or ranking penalties. Typed, corrected, and transcribed explanations retain their evidence provenance; this module does not interpret accent, voice quality, speed, or disability.

Observation history also records the report's model, prompt version, confidence, correction flag, and assessment source (authored, model, or staff-reviewed). Comparison groups retain the original scenario version, rubric version, model/prompt version, mode, freshness, assistance permission, and categories of help received. Accessibility settings are not ranking or comparison penalties. A repeated `Strong` finding remains useful deliberate-practice evidence but cannot demonstrate fresh-task transfer. Different conditions are shown as `conditions-vary`, rather than claiming that a change in labels establishes improvement.

The initial coverage threshold is two distinct fresh tasks assessing the **exact stored criterion ID** before showing `multiple-fresh-task-observations`. This is a disclosure threshold, not a validated statistical cutoff or mastery standard. All findings remain provisional. Current task-specific criterion IDs often cannot meet this threshold; the module states that limitation instead of treating a related editorial topic as an identical assessment scale.

## Recommendation policy

The policy uses the latest observed `Needs work` and `Developing` findings as provisional practice targets. Selected learner competencies guide ordering without creating an assessment. Targets selected by the learner come first; within that group, `Needs work` precedes `Developing`, then the latest observation and stable criterion ID break ties.

Task ordering is deterministic:

1. Unseen tasks sharing a provisional gap criterion or authored transfer topic.
2. Unseen tasks aligned with selected competencies.
3. Other unseen tasks for exploration and evidence collection.
4. Repeated tasks sharing provisional gaps, then selected goals, then remaining repeats.

Within each category, goal alignment, target priority, number of matched targets, and stable scenario ID break ties. Provider outputs, help conditions, accommodations, and random numbers do not influence ranking.

Current rubric IDs are scenario-specific. An explicit editorial map connects related topics such as verification, input validation, retry identity, concurrency, state invariants, repository comprehension, and interface compatibility. The map is used only to suggest practice, with `matchingBasis: authored-transfer-map`. For example, a monetary validation gap can suggest invoice conflict validation. This does not imply that invoice conflict semantics and monetary validation are equivalent rubrics, or that success on one proves the other. Original skill histories and levels are never merged through aliases.

The bounded plan selects an unseen task first when one exists, then an authored drill attached to a provisional gap in its original scenario version, then a related Foundry lesson reference. Uncompleted drills precede completed drills. If all relevant drills are self-reported complete, a repeat drill is labeled explicitly. When no unseen task exists, a deliberate scenario repeat can fill a remaining step, labeled as unable to establish fresh-task transfer. There are never more than three steps.

The output preserves missing coverage in `gapsWithoutFreshTask`. An unrelated unseen task can collect new evidence, but its recommendation never claims that it validates an unsupported gap. An empty catalog yields only applicable drills and lesson references, or an empty plan with an explanation. Unsupported selected competencies appear in `unresolvedGoals`; no content or URL is fabricated for them.

## Foundry lesson references

On 2026-10-09 the following paths were verified in the local main Engineering Foundry source, including route handlers and published lesson data:

| Topic | Source route reference |
|---|---|
| Contract reasoning and verification | `/dsa/foundations/correctness` |
| Validation, invariants and failure semantics | `/low-level-design/lessons/state-lifecycle-errors` |
| Concurrency and testability | `/low-level-design/lessons/concurrency-testability-evolution` |
| Interface compatibility | `/low-level-design/lessons/relationships-interfaces` |
| Repository boundaries and responsibility | `/low-level-design/lessons/responsibilities-ownership` |

The source was `data/dsa/foundation-lessons.ts`, `data/low-level-design/index.ts`, `app/dsa/[...segments]/page.tsx`, `app/low-level-design/lessons/[slug]/page.tsx`, and the public route inventory in the main repository. These are source-verified integration references, not a claim that this standalone lab serves those pages or that a production domain was tested. They intentionally have `foundryPath` and `requiresFoundryIntegration: true`, with no invented live origin or clickable standalone `href`. The main-site integration must resolve paths against its verified navigation/publication rules. The correctness lesson's 20-minute planning estimate is an initial estimate; the low-level-design durations follow the source lesson metadata.

## Verification and remaining qualification

The regression suite covers report corrections, original observation dates, missing/unknown evidence, duplicate attempts, unobserved skills, frozen content versions, comparable conditions, assistance permission versus actual help, accessibility neutrality, fresh/repeated exposure, exact-criterion coverage thresholds, selected goals, transfer matching, empty/exhausted catalogs, self-reported drills, deterministic input ordering, and caller-data immutability.

No live model/provider calls, training, Docker operations, hosted database changes, or public deployment are required by these tests. Editorial transfer mappings, the two-task disclosure threshold, recommendation usefulness, and downstream learning gains remain pending expert/pilot review. The module's passing tests establish deterministic policy behavior, not measured learning efficacy.
