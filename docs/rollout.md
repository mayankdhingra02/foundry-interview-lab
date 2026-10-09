# Practice rollout and report-generation gates

These gates control who can start new practice, which scenario packages accept new attempts, and whether paid AI coaching may run. They are independent of saved-session access, workspace saving, the frozen evidence ledger, account ownership, and the billing entitlement check. They do not establish content quality, security qualification, or permission to launch publicly.

## Configuration and defaults

| Server variable | Local/test when unset | Production when unset | Accepted values |
|---|---|---|---|
| `PRACTICE_ADMISSION_MODE` | `open` | `staff` | Exactly `staff`, `invite`, or `open` |
| `PRACTICE_ADMITTED_SCENARIOS` | All known original packages | No scenarios | Comma-separated exact known scenario IDs; explicit empty string retires all |
| `ADMIN_USER_IDS` | Empty | Empty | Comma-separated canonical lowercase UUIDs from verified server accounts |
| `INVITED_PRACTICE_USER_IDS` | Empty | Empty | Comma-separated canonical lowercase UUIDs from verified server accounts |
| `FEATURE_REPORT_GENERATION` | Enabled | Disabled | Only literal `true` enables; any other supplied value disables |
| `FEATURE_AI_INTERVIEW` | Existing enabled default | Existing enabled default | Existing global inference switch; a valid model/key configuration is also required |

The example local environment explicitly sets `FEATURE_REPORT_GENERATION=false`. Supplying a provider key alone therefore does not enable AI coaching when using that example. The other new admission variables are commented out there, preserving the documented environment-dependent defaults.

Staff mode admits only `ADMIN_USER_IDS`. Invite mode admits staff plus `INVITED_PRACTICE_USER_IDS`. Open mode admits verified owners without requiring an entry in either list. Authentication is still required by the API; open does not mean anonymous. User lists are admission policy, not a substitute for the existing server actor verification.

CSV entries may have surrounding spaces. Wildcards, emails, prefixes, uppercase UUIDs, unknown scenario IDs, empty entries within a list, duplicate entries, and overlarge lists fail closed. A malformed scenario configuration produces an empty admitted catalog and a safe 503 on an admission assertion. A malformed admission mode or user list denies new owner admission with a safe 503, including in open mode. A valid policy that excludes the owner or scenario produces a safe 403. Error messages do not echo configured IDs or rejected learner data.

The two admission policies are separate: a permitted owner also needs an admitted scenario. A valid staff list alone does not open production, because its default scenario list is empty.

## Integration points

`lib/server/rollout.ts` exports:

```ts
admittedScenarios<T extends { id: string }>(catalog: T[]): T[]
assertScenarioAdmission(id: string): void
assertPracticeAdmission(verifiedOwnerId: string): void
rolloutAdmissionPolicy(next?: (context: SessionAdmissionContext) => Promise<void>)
```

The application service installs `rolloutAdmissionPolicy` around the existing billing admission hook. The session service passes the resolved immutable package's `scenarioId` and `scenarioVersion` in `SessionAdmissionContext`. After the existing successful-request replay lookup, the policy evaluates scenario admission, then verified owner admission, then billing within the same session admission transaction. A rollout denial cannot consume a billing entitlement or write an admission debit. A billing rejection still rejects the admission transaction.

The API applies catalog filtering in these locations:

1. Filter the new-practice catalog with `admittedScenarios(listScenarios())` before `toPublicScenario` and transport. Pass the admitted catalog to progression recommendations as well.
2. Parse a session-creation request and call `service.createSession(actor.id, input)`. Its configured transactional admission policy enforces the scenario and owner gates for genuinely new attempts. The owner ID continues to come only from `requireActor`.
3. Leave saved-session GET/export/events, saves, commands, runs, report completion, and private author previews on the original package resolver. Do not call scenario admission assertions on those paths.

Do not place scenario or owner admission assertions before `createSession` at the HTTP boundary. An exact successful request must replay its acknowledged response after scenario retirement, owner rollout closure, or a later configuration error. `SessionService` resolves that replay before invoking admission policy, without another billing debit. Reusing a request key with changed input still fails the existing fingerprint check. New request keys must satisfy the current policy. Directly constructed services intended to enforce rollout must install `rolloutAdmissionPolicy`; domain fixtures can inject their own policies.

Scenario ID membership is sufficient for the release gate. Immutable version resolution and package pinning remain the existing content/session contract; changing the admitted ID list neither authorizes an unknown version nor makes an edited package compatible with a saved attempt.

Retirement never removes files from `content/scenarios`, changes `getScenario(id, version)`, or rewrites stored scenario/rubric versions. A learner's original task, reference package on the server, evidence, report, and authored drill remain tied to their saved version. Packages needed by saved attempts must remain available even after they stop accepting new practice.

## Independent paid coaching switch

`capabilities()` now exposes `coaching` independently of `ai`, `interviewer`, and `assistant`:

- `ai` retains the existing configured/global-inference meaning.
- `interviewer` and `assistant` retain their existing global AI gate.
- `coaching` requires configured AI inference **and** `FEATURE_REPORT_GENERATION` enabled under its environment default.
- `details.coaching` distinguishes disabled report inference from unavailable inference and explains the observation-only result. No configuration or quality claim means a qualified release.

The application initializes the coach reservation at zero when coaching is disabled. Existing orchestration then marks that job `forceAuthored`; it can finish with a labeled observation-only report without paid inference. Interviewer/assistant reservations and their existing caps are unchanged.

For already-queued paid coach jobs, the provider checks `capabilities().coaching` when processing begins and checks it again on the inference path before a request is sent. Closing the gate returns `authored-observation-only`, `Not observed` for every criterion, an explicit explanation that no assessment was produced, and authored next-practice suggestions. Frozen evidence and saved work stay intact. An uncalled provider request settles at zero actual spend and releases its reservation through the existing transaction. The worker can complete the learner's report instead of losing the submission.

The report switch does not erase old reports or prevent staff from reviewing preserved evidence. `FEATURE_AI_INTERVIEW=false` still disables interviewer, assistant, and coach model inference together, regardless of the report switch. Execution, voice, and billing keep their separate existing controls.

A switch checked before a request cannot retract an already-sent provider call or guarantee a refund. Existing cancellation, uncertain-spend recording, leases, and settlement remain responsible for in-flight work. Deployment environment changes normally require updating/restarting the relevant processes. Reservation configuration is captured by the application service at initialization; enabling reports after a service started with zero coach reservations requires rebuilding that service instance before newly queued jobs can use paid inference. Closing the provider gate is still rechecked for queued work.

## UI usage

The progress/catalog UI should use the admitted catalog rather than display retired tasks as new-practice choices. Saved history remains visible, and its resume/review links must not depend on admission status.

Setup text uses `capabilities.coaching` and `details.coaching` for coaching availability. `capabilities.ai=true` alone does not imply AI assessment is available. A disabled report gate explains the observation-only report while keeping Finish coding, final submission, history, report evidence, and export available. Reports preserve their actual assessment source; observation-only reports are not presented as a skill assessment and `Not observed` is not a weakness. An empty admitted catalog directs learners to saved attempts instead of suggesting that another search will reopen practice.

The HTTP regression covers retirement, catalog/progression filtering, saved workspace access and exact creation replay without another billing hook. Two browser checks cover closed catalog guidance and disabled coaching while the coding assistant remains configured.

## Release procedure

1. Retain production's closed defaults while qualifying original content, account access, execution, report correctness, recovery, and operational limits.
2. Explicitly admit only the intended reviewed scenario IDs. Add staff account UUIDs and use staff mode for internal practice.
3. Use invite mode and exact invited account IDs for a bounded pilot when the release owner approves. Keep model/report, execution, voice, billing, and quota settings explicit.
4. Enable paid report generation only after the corresponding report-quality gate is satisfied. This flag does not satisfy the separate two-independent-review evaluation requirement.
5. Move to open admission only as an explicit server configuration decision. Remove a scenario ID or close report generation independently if that feature needs investigation; preserve saved packages and evidence.

Environment allowlists are appropriate for an initial bounded rollout. An administrative invitation/retirement UI, audit history for configuration changes, and a dynamic control plane are not implemented here. No automatic release decision is made from deterministic tests.

## Verification

Tests cover closed production defaults, local defaults, exact known scenario IDs, generic catalog metadata, explicit empty retirement, saved version resolution/history/saving after retirement, exact staff/invite membership, malformed modes and lists, billing hook ordering, admission rollback, successful request replay after retirement/owner closure/malformed later configuration, changed-input replay rejection, resolved scenario/version admission context, global versus report-specific AI controls, malformed report flags, zero application coach reservation, and a paid job queued before report generation closes. Fetch is stubbed; the queued-job test proves no provider request is sent, original frozen evidence is retained, and an observation-only report completes with zero actual spend.

No live model calls, Docker operations, hosted database changes, public deployment, or launch qualification occur in this workstream. Actual hosted billing and rollout behavior remain subject to the project's integration/release checks.
