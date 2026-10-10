# Host adapter boundary

This is the first software seam for integrating Interview Lab into Engineering Foundry's existing application. It does not mount the Lab in Foundry, deploy infrastructure, install database migrations, share an account lifecycle, or replace the execution worker. The standalone application remains the default.

`createPracticeApi(host)` in `lib/server/practice-dispatcher.ts` returns the existing practice dispatcher. The framework Route Handler continues importing `practiceApi` from `lib/server/practice-api.ts`; that thin standalone composition supplies the same authentication, service, capability, rollout, navigation, speech/review and local-worker implementations as before. Request schemas, statuses, private no-store responses, ownership, CAS, request replay and execution admission ordering remain in place.

A host supplies trusted server dependencies through `PracticeApiHost`:

- `resolveActor(request)` returns a provider-verified account ID, or `null` for a verified anonymous request. An identity outage must throw a safe operational error; it must never become anonymous or create a local identity. The dispatcher returns 401 for `null` and preserves an explicit 503 for unavailable verification. Client headers, cookies and payload owner fields do not select the service owner.
- `getService()` returns the existing `SessionService`, composed with the host's durable store, immutable scenario resolution, quota/admission limits, rollout policy, and admitted runtime/inference bindings. The adapter does not replace these deterministic policies. Capability flags are availability decisions, not authorization or evidence.
- `capabilities`, `listScenarios`, `admittedScenarios`, `withNavigation` and `executionAdmissionOpen` provide the host's current trusted availability/catalog policy. The dispatcher still sanitizes the public catalog and validates progression goal IDs. Fresh run/assistant readiness checks remain inside the service's replay-aware guard; acknowledged retries keep their original result when availability changes.
- `origin()` provides a canonical HTTP(S) origin from server configuration. Mutations require an exact matching `Origin` header. No request `Host`, forwarded host, query or body determines the trusted origin. Noncanonical host origin configuration fails closed. Read behavior retains the previous origin-independent semantics.
- `interact` supplies the host-composed deterministic interaction service, including its clock and admission limits. It cannot silently construct an ambient-policy service. The standalone wrapper preserves its previous interaction composition.
- Review/voice delegates receive the verified owner ID and must retain the existing owner, consent, feature, quota and method checks. `exportReviews` is required so private review records cannot silently disappear from session exports. The standalone delegates retain their existing policies; actual host implementations are future work.
- Telemetry callbacks retain content-free, best-effort collector behavior. `notifyWorkAvailable()` is a best-effort signal after acknowledged mutations and successful single-session reads, at the standalone dispatcher's existing notification points. Creation continues its existing behavior without a new notification. Notifications may repeat on request replay and must not be the durable queue or an authorization boundary. The dispatcher does not await their completion; a rejected or never-settling notifier cannot invalidate or delay the acknowledgment. Hosts must use an appropriate retained task/trigger mechanism and independently reconcile queued work and expired leases; this adapter does not establish a serverless background-task lifecycle guarantee.

The factory has no runtime dependency on standalone authentication, application construction, configuration, local worker, or standalone review/voice route composition. `http-core.ts` holds shared body parsing, error envelopes and explicit-origin handling; `http.ts` retains the default standalone-origin wrappers and reexports the same `HttpError` class. This prevents separate error identities or envelope drift.

## Reviewed route profiles

`lib/interview-practice/routes.ts` defines deeply frozen `standalone` and `foundry` profiles. The default retains current standalone routes. The Foundry profile describes the proposed feature namespace:

| Purpose | Standalone | Foundry contract |
| --- | --- | --- |
| Feature/workspace | `/interview-practice`, `/interview-practice/:id` | Same |
| History/progress/preferences | `/history`, `/progress`, `/settings` | `/interview-practice/history`, `/interview-practice/progress`, `/interview-practice/settings` |
| Shared account settings | `/settings` | `/settings/account` |
| Support page/API | `/internal`, `/api/internal` | `/interview-practice/internal`, `/api/interview-practice/internal` |
| Practice API | `/api/interview-practice` | Same |
| Identity observation | `/api/auth/session` | `/api/interview-practice/identity` |
| Practice-data deletion/export | `/api/account`, `/api/account/export` | `/api/interview-practice/account`, `/api/interview-practice/account/export` |

The Foundry profile is a path contract; these additional endpoints/pages are not implemented by selecting it. Practice-data deletion is distinct from shared identity-account deletion. Foundry's existing full account export must eventually include Lab-owned data through a separate lifecycle integration.

`practiceWorkspacePath` accepts only a bounded UUID; `practiceApiPath` accepts known API templates and UUID dynamic segments. Profiles are an exact runtime allowlist. No arbitrary URL, base path, external host or learner-selected routing configuration is accepted. Queries remain separate. The current client API prefix consumes the standalone contract; this change deliberately does not rewrite all UI links or install a runtime mount selector.

## Verification and remaining integration work

`tests/practice-host.test.ts` drives the actual dispatcher and real `SessionService` with in-memory durable semantics and an injected verified identity. It tests unavailable versus anonymous identity, foreign ownership, public sanitization, creation/workspace replay and CAS, CSRF, availability changes, strict controls, owner export, extension delegation and notifications after commit. Throw-on-import sentinels prove the host core does not require standalone identity/configuration/application/worker modules. `tests/practice-routes.test.ts` checks the reviewed path contracts and rejects arbitrary destinations. Existing standalone API and HTTP tests cover unchanged composition.

These tests do not qualify Foundry cookie integration, hosted PostgreSQL, deployment routes, account deletion/export hooks, feature CSS/themes, global privacy/navigation registration, a Cloudflare workspace runner, a bounded hosted job trigger, provider quality or operational spend limits. Those remain separate focused changes and deployment gates. No database, model, speech, Docker or other external execution is required for this adapter's tests.
