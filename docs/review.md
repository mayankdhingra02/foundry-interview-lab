# Internal review and support

This workstream implements learner disputes, permissioned support inspection, authored scenario preview, bounded recovery, and independently reviewed report corrections. It uses the existing Foundry identity. It does not grant staff arbitrary SQL access, unrestricted impersonation, or authority to silently replace completed feedback.

## Identity and permissions

Every HTTP route calls the existing `requireActor(request)` authentication boundary. Learner ownership always comes from that verified actor, never from a request body. Internal access additionally requires the actor's exact ID in the server-only comma-separated `ADMIN_USER_IDS` allowlist. Matching is case-sensitive. An empty list denies all staff access. Local signed-cookie identities can be explicitly allowlisted during development; production rejects local identities even if an ID is listed. This setting does not create an admin account or alter shared Foundry identity records.

`GET /api/internal/access` returns `{allowed:boolean}` for an authenticated actor, so navigation can discover staff access without loading private records. All other internal routes deny unlisted actors. Route responses use `Cache-Control: private, no-store`; mutations require the configured application Origin and strict bounded JSON. Client-supplied owner IDs, staff IDs, SQL, arbitrary commands, and undeclared fields are rejected.

A learner can open a support case without granting either permission. The staff queue and status view then contain only operational metadata: case/session/report IDs, lifecycle, stage, revision, scenario version, most recent acknowledged snapshot time, numerical usage, job kind/state/attempt, static failure category, report generation IDs, and correction draft metadata. The dispute message, code, turns, actual failure descriptions, report prose, draft prose, and audit purposes are absent. Refund eligibility is explicitly `requires-separate-reviewed-policy`; no refund decision or financial mutation is fabricated.

The learner chooses two independent, initially unchecked permissions:

- `inspectionConsent`: read this attempt's private contents and support request, and prepare/review a correction using its frozen evidence.
- `supportActionsConsent`: retry a failed report or cancel a pending job within the original service limits. This permission alone does not expose private contents.

Allowed permissions expire seven days after creation or an explicit renewal. A consent update uses the case's separate `expectedRevision` and a durable request ID. Revocation immediately blocks future inspection, drafting, review, publication, and bounded actions, including replay of an old inspection/publication key. It cannot undo content already viewed or actions already committed. Authorization and consent are rechecked inside the transaction that applies each fresh operation. The support service does not implement research sample reuse; support permission never authorizes evaluation reuse, model training, or another learner's examples.

## Service and route contracts

`ReviewService(store, resolveScenario, options?)` accepts the same configured `PracticeStore` as `SessionService`; optional settings are `adminUserIds`, `now`, `allowLocalAdmins`, and `practice`. `getReviewService()` binds the current application service and exact authored scenario resolver. Every mutation requires an idempotency request ID of 8–128 safe characters. Stored review idempotency results are reference IDs, rather than cached private inspection or draft bodies.

Learner routes are wired by the existing practice API catch-all:

| Method and path | Request fields beyond `requestId` | Result |
| --- | --- | --- |
| GET `/api/interview-practice/sessions/:id/reviews` | None | `{cases}` for this owned attempt |
| POST the same path | `category`, optional `reportId`, `message`, optional `criterionIds`, both consent booleans | `{case}`; HTTP 201 |
| POST `/api/interview-practice/reviews/:caseId/consent` | `expectedRevision`, both consent booleans | `{case}` |

Categories are `feedback` or `technical`. Feedback cases must name a published report belonging to this attempt. Criterion IDs must be authored rubric IDs. There is one open case per attempt/category/report and a limit of ten case creations per owner per UTC day in the retained case corpus. This is a support abuse bound, not a commercial entitlement or a deletion-proof historical counter. Messages are limited to 4,000 characters. Revocation or renewal does not require staff approval.

The Node internal catch-all implements:

| Method and path | Input | Result |
| --- | --- | --- |
| GET `/api/internal/reviews` | None | `{cases}`: latest 100 content-free case summaries |
| GET `/api/internal/reviews/:caseId` | None | `{case,session,drafts}`: metadata only |
| POST `/api/internal/reviews/:caseId/inspect` | `requestId,purpose` | `{case,session,snapshots,drafts,decisions,researchReuseAuthorized:false}` |
| POST `/api/internal/reviews/:caseId/drafts` | `requestId,sourceReportId,reason,report:CoachOutput` | `{draft}`; HTTP 201 |
| POST `/api/internal/reviews/drafts/:draftId/review` | `requestId,decision:'approve'|'reject',note` | `{decision}` |
| POST `/api/internal/reviews/drafts/:draftId/publish` | `requestId` | `{case,report}` |
| POST `/api/internal/reviews/:caseId/recover` | `requestId,action:'retry-report'|'cancel-job',jobId?` | `{caseId,operation,job}` with job metadata only |
| POST `/api/internal/reviews/:caseId/resolve` | `requestId,resolution` | `{case}` with learner-visible resolution |
| GET `/api/internal/deletions` | None | `{deletions}`: last 100 content-free cleanup statuses |
| POST `/api/internal/scenarios/:id/preview` | `requestId,purpose,version?` | `{scenario,scenarioDigest,privateMaterial:true,executionQualifiedByThisPreview:false}` |

Inspection and scenario preview require a nonempty, at most 300-character stated purpose. Author preview exposes private tests and reference files only to allowlisted staff and records the package ID/version and purpose in an immutable audit. It neither runs code nor establishes educational quality. Queue/status/deletion views also record content-free access audits. Inspection returns snapshots and the redacted owner session representation; it does not expose provider credentials or worker inference diagnostics.

## Immutable correction protocol

A correction requires a completed attempt, an existing published source report, the original code-frozen snapshot, and the final immutable evidence manifest. The server resolves the exact original scenario version and verifies its digest and rubric version. A missing or changed package fails closed; staff cannot substitute today's scenario or invent new observations.

The author submits a bounded `CoachOutput` and a learner-visible reason. `validateReport` checks the authored rubric/drill IDs, allowed finding/confidence values, citation resolution, missing-evidence behavior, and explicit test-result assertions against frozen executed checks. A citation resolving does not establish semantic truth. Staff must still read each substantive claim and compare its wording with the actual evidence.

The draft receives new report and generation IDs, copies the source evidence digest/watermark, and is persisted separately from the published owner session. It cannot be edited after creation. A revision requires a new draft. A different currently authorized staff actor must approve or reject it with a bounded review note; one immutable decision is allowed per draft. Rejection cannot be silently changed to approval. Unpublished drafts never appear in ordinary `SessionView` responses.

Publication rechecks current inspection consent, independent approval, the original package, latest source generation, and the frozen evidence digest/watermark. One transaction appends the new report, records its publication, appends `coaching.corrected`, resolves the case with the visible reason, and writes the audit. The original report and final evidence remain unchanged. The new report records `model:'staff-reviewed'`, `promptVersion:'manual-correction-v1'`, the original rubric version, and public `correction:{sourceReportId,reason,publishedAt}` metadata. These provenance labels do not claim a new provider inference. Concurrent drafts cannot both replace the same latest source; the first valid publication wins and the other fails as stale.

## Bounded operational recovery

`recover` uses narrow trusted guard callbacks on `SessionService.retryReport` and `cancelJob`. The configured practice service must share the exact store instance. The guard verifies that the support case is open/triaged, permission is current, and the target job belongs to that attempt. The action and its audit commit together; a rejected transaction leaves neither action nor audit.

A retry reuses the original coaching job ID, generation input, snapshot, and frozen evidence. Existing quota reservation, retry count, and AI call limits remain authoritative. Cancellation is limited to queued/running jobs and uses the original fencing transition, so a late worker result is rejected. The support service performs no provider calls itself and has no arbitrary command, queue payload editor, evidence editor, refund endpoint, or identity impersonation endpoint. Recovery returns operation metadata, never the full private session merely because action consent was granted.

## Persistence, export, and deletion

Apply `202610090006_reviews.sql` after the foundation/runtime migrations, then `202610090007_event_contract.sql` before deploying correction writers. Commerce and voice migrations are separate workstreams; the review protocol depends on migrations 0001/0002/0006/0007. The adapter detects the additive review tables so baseline sessions can still be read before 0006 is applied; review writes require the migration. Migration 0007 strictly extends the v1 SQL vocabulary to accept the application's correction/proposal events; see [postgres-compatibility.md](postgres-compatibility.md).

Five normalized tables store cases, correction drafts, decisions, publications, and audits. Composite foreign keys bind records to the same owner, attempt, case, draft, and published report. Unique constraints prevent duplicate publication and decision records. Draft/decision/publication/audit UPDATE triggers reject rewrites. Runtime payloads are bounded per entity. The privileged server adapter additionally checks immutable records before diff persistence and serializes the whole transaction under the same advisory lock as session admissions and worker state.

RLS permits an authenticated SQL client to SELECT only its own case rows. Direct client access to drafts, staff decisions, publications, and audits is denied, as are all client writes. These records are accessed through the permissioned server workflow. The existing trusted service-role connection can read across users, so application authentication, owner checks, allowlisting, and consent remain mandatory. SQL constraints are defense in depth; they do not replace staff permission checks or prove correctness of report prose.

`exportOwner(ownerId, sessionId?)` returns owned case/correction content and disclosures for unpublished drafts. An optional attempt filter validates ownership and excludes unrelated attempts from every exported collection. The export removes staff actor IDs and operational audit purposes; its audit subset contains action/time/reference metadata. Ordinary owner session responses exclude unpublished drafts. Root account and per-session export routes compose this review export with existing practice/commerce exports.

Attempt or Lab-data deletion removes learner-linked cases, drafts, decisions, publications, audit rows, and session-associated idempotency references in the same transaction as attempt removal. PostgreSQL cascades and adapter diff persistence cover these private copies. Global staff author-preview and metadata queue audits contain no learner contents and have no learner session link. Lab-data deletion preserves the shared Foundry identity and content-free usage/commerce counters under their separately documented retention policies. No extra review export files or audio objects are staged by this service. Downloaded exports, database backups, upstream provider copies, and future external support systems require their own retention rules; this implementation does not promise universal instant erasure.

The inherited aggregate PostgreSQL adapter still loads a bounded corpus and serializes writes under one lock. Review audit growth shares its documented capacity limits. This implementation has no pagination beyond the latest-100 queue view, automatic review archival, staff SSO/role management UI, research participation workflow, refund adjudication, or external ticket system integration. Qualify workload, retention, incident procedures, and staff access reviews before wider release.

## Verification and qualification status

Local checks performed for this workstream: 25 deterministic review service/HTTP/persistence-boundary tests passed; the combined review, domain, and event contract suite passed 93 tests. TypeScript and ESLint passed. Fixtures explicitly synthesize job outputs; no provider request, learner execution, production account operation, or payment mutation is represented as tested here.

Seven real-PostgreSQL integration cases are authored in `tests/review-postgres.integration.test.ts` and added to the existing isolated CI qualification step. They create their own disposable database/container, bootstrap synthetic Supabase-compatible auth roles, apply migrations 0001/0002/0006/0007, and run the adapter under actual service-role grants. They cover normalized restart round trips; owner RLS and direct-client denial; immutable/composite SQL constraints; concurrent publication; validation rollback; consent/deletion; and recovered worker fencing. They ignore `DATABASE_URL` and cannot touch a hosted database.

The first GitHub CI execution (`37988813054`) passed five review SQL cases and failed concurrent publication and revoked-consent error handling. It also failed the baseline assistant-edit persistence case. The strict SQL event vocabulary and trusted HTTP error handling were repaired in a separate change. **A fresh SQL run must verify those fixes before qualification can be claimed.** The current task prohibits local Docker use, and no local review SQL run was made. Preserve the failed CI evidence; deterministic tests and the updated CI definition do not constitute a passing SQL run.

When that restriction is explicitly lifted or in an authorized CI run with the PostgreSQL image provisioned:

```sh
RUN_POSTGRES_INTEGRATION=1 npm test -- tests/review-postgres.integration.test.ts
```

Routine non-Docker checks:

```sh
npm test -- tests/review.test.ts tests/review-routes.test.ts tests/review-event-boundaries.test.ts
npm run typecheck
npx eslint lib/server/review-service.ts lib/server/review-api.ts tests/review*.ts
```
