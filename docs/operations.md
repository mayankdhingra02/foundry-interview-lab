# Operations and deployment

The web process serves pages and short authenticated commands. A persistent bounded worker claims durable jobs and executes code in isolated Docker containers. PostgreSQL stores acknowledged snapshots, event history, job fencing, reports, quota postings, and content-free operational state. A web request never owns a whole interview or executes learner code on its host.

This repository provides local recipes and reproducible qualification. No public service, hosted database, production monitor, backup schedule, or paid provider integration was deployed by this work.

## Environments and prerequisites

Use separate development, staging, and production identities, databases, storage, provider budgets and webhook configuration. Development can use the file adapter and local signed identity. Production explicitly rejects that identity/storage combination; it requires verified Supabase accounts and PostgreSQL. The disposable auth-shaped database used in qualification is not an authentication service and must never be applied to a real Supabase project.

`Dockerfile` provides distinct `web` and `worker` targets. Both run as the Node user. The web target has no Docker client/socket requirement. The trusted worker target includes the Docker CLI and needs permission to reach a dedicated daemon containing the approved Python image. Its socket permission is host-administrative authority: use a dedicated execution host and restricted deployment identity. The learner containers it creates receive no host mounts, socket, secrets, or external network. See `docs/execution.md` for exact confinement and the shared-process grading limitation.

`deploy/compose.yml` has a disposable PostgreSQL `qualification` profile and a staff/staging `app` profile. It binds exposed ports only to localhost. `deploy/README.md` explains setup, public Supabase build arguments, secret injection, socket permissions and deliberate image provisioning. Runtime dependencies are installed with `npm ci --omit=dev`; tsx is pinned as a production dependency for workers, and lint/test/compiler packages are omitted. Build-time TypeScript configuration is transpiled to JavaScript for runtime startup. Image vulnerability review remains deployment work. Pin reviewed base/runtime digests and record them with each release. Do not include `.env`, learner history, recordings, test outputs or private traces in build context; `.dockerignore` excludes them.

Supply a TLS reverse proxy, trusted network rules, secret manager and verified identity before opening external traffic. Voice and billing stay disabled until their separate contracts and release evidence pass. Model inference uses authored fallbacks when unavailable. A configured key or container build does not establish model quality.

## Health, admission and worker heartbeat

`GET /api/health` is process liveness and performs no model or sandbox execution. `GET /api/health/readiness` is a strict operational gate returning 200 only when required checks are ready, otherwise 503. Its response contains fixed safe status codes and a timestamp; it never includes database URLs, credentials, worker IDs, learner code, dialogue, reports, or raw exceptions.

Readiness checks identity/origin configuration, a bounded PostgreSQL connection, required schema presence, a worker heartbeat within 90 seconds, the last worker probe of the approved cached runtime when execution is enabled, and the shared admission hold. The worker probes image availability rather than pulling an image or running arbitrary code. Configuration presence is not external identity-provider availability, and image availability is not public-host isolation qualification. This endpoint should be an operator/release monitor. Do not evict every web instance solely because execution or a worker is unavailable: saves, exports and history must remain reachable. A dedicated core-storage routing probe is still needed for orchestrators that require that distinction.

Use one stable ID per worker process for both claims and `startWorkerHeartbeat(workerId)`. It records content-free state every 15 seconds; the returned async stop function records graceful shutdown. The job heartbeat remains separate and aborts a run on lease loss. Idle worker heartbeat is essential: a healthy empty queue should not look like a dead worker. Heartbeat write failures emit a fixed safe category and must alert; they do not print connection strings or learner artifacts.

`practice_operations_state` holds shared execution admission. Workers check `executionAdmissionOpen()` before executing a run. Unconfirmed runner cleanup closes the runner's process-local latch and invokes `blockExecutionAdmission()`; heartbeat retries propagation if storage was temporarily unavailable. New runs fail closed while a shared hold or database failure persists. This holds expensive execution; ordinary acknowledged-work APIs remain separate. An operator clears the shared hold only after reconciling abandoned execution containers and resets/restarts affected worker processes. No learner reset endpoint exists.

The operations tables grant no anonymous or authenticated learner access. Service-role access is server-only. Heartbeat rows and shared hold state contain no learner/session foreign keys or content. Expire stopped/stale heartbeat rows periodically under an operator retention policy; never use them as learner analytics.

## Disposable migration, load and recovery qualification

Deliberately provision `postgres:16-alpine` and use the existing Node/tsx environment:

```sh
FOUNDRY_OPERATIONS_QUALIFICATION=1 node --conditions=react-server --import tsx scripts/operations/qualify.ts --output work/operations-qualification.json
npm test -- tests/operations.test.ts
```

The CLI never reads `DATABASE_URL`. It creates a new random-name PostgreSQL container on a random localhost port, with a random disposable password, applies the auth test stub and every migration in sorted order, and uses actual service-role grants for application operations. It removes only its own container on completion/failure. It never prunes Docker, changes an existing database, invokes a provider, or executes learner Python on the host.

The smoke uses ten simultaneous synthetic sessions and 50 durable workspace saves. Every save is replayed with the same request key and reloaded through a new service adapter. It verifies stale-revision rejection, lease takeover and old-worker fencing, fresh heartbeat/readiness, a shared cleanup hold, anonymous denial of operations rows, and backup/restore into a second disposable database. The restore compares complete session metadata fingerprints and snapshot content digests. Dumps stay in process memory and are not printed or committed.

All recovery checks must pass and save p95 must be below the design's proposed 1,000 ms target. A failure exits nonzero and is a finding, not a reason to relabel the threshold. The result records raw sample counts and timings. This is a small localhost smoke with synthetic data; it does not establish hosted throughput, text/voice latency, monthly availability, browser disconnect behavior, or production disaster recovery.

Local qualification on October 9, 2026 applied migrations 001–005 and passed all recovery checks. Ten concurrent synthetic sessions made 50 acknowledged saves: p50 500 ms, p95 866 ms, maximum 874 ms. The disposable backup/restore comparison matched and took 522 ms. These measurements describe that single developer-machine run only. The transactional adapter currently serializes mutations under an advisory lock and reads normalized state; measure growth and lock contention before increasing the hosted envelope.

The CI `isolated-qualification` job deliberately provisions public Python/PostgreSQL images, runs real sandbox and PostgreSQL integration suites, runs this smoke, and uploads only its content-free summary for seven days. CI is configured here; a successful local run does not claim that GitHub has executed the new workflow. Ordinary unit CI uses fixture/provider-disabled behavior. Live model smoke requires a separately approved budget and cannot manufacture independent quality review.

The PostgreSQL job includes billing and voice persistence integration with synthetic provider fixtures. A separate Chromium job deliberately installs its browser, generates a local-only identity secret without printing it, disables AI/voice/billing inference, and runs the learner/recovery journey on localhost port 3134 with real Docker execution. Failure artifacts contain only synthetic test attempts and expire after seven days. No `.env.local` or secret is uploaded.

## Deployment image startup smoke

Build and qualify already-built local images without publishing them:

```sh
docker build --target web --tag foundry-lab-ops-qualification:web .
docker build --target worker --tag foundry-lab-ops-qualification:worker .
FOUNDRY_CONTAINER_SMOKE=1 node --conditions=react-server --import tsx scripts/operations/container-smoke.ts
```

The smoke launches only those local image tags, binds a random localhost port, checks liveness/homepage and expected missing-storage readiness failure, checks UID 1000 and omission of lint/test/compiler packages, imports the worker runtime with tsx, checks Docker CLI startup, and removes its own web container. It supplies no real credentials or Docker socket. This is image/startup qualification, not a hosted account or execution-host qualification. The CI `deployment-images` job runs the same builds and smoke.

Local image qualification is incomplete. An initial web image built successfully. After runtime dependency minimization, `npm ci --omit=dev`, webpack, TypeScript and page generation succeeded, but Docker Desktop failed during layer export with metadata input/output errors; a worker build then failed at daemon metadata access. Read-only diagnosis showed only 1.4 GiB free on the host Data volume and Docker inventory also failed with I/O errors. No unrelated Docker cleanup or restart was attempted. The final tightened images and startup smoke must be rerun after host/daemon recovery; the earlier full-dependency image is not final release evidence. Production dependency audit reported zero advisories; the known development-only advisory baseline remains documented in `docs/development.md` and those development tools are excluded by the runtime install recipe.

## Orphan container runbook

Owner: platform/on-call responder. Trigger: any missing cleanup acknowledgement, a shared execution hold, repeated runner timeouts, or labeled containers surviving their bounded execution window.

1. Hold execution admission and stop accepting new run work. Preserve workspace saves and private history. If cleanup was unconfirmed, the worker latch/shared hold already closes admission; verify propagation before restarting workers.
2. Inspect a dry-run inventory on the dedicated runner host:

   ```sh
   node --conditions=react-server --import tsx scripts/operations/reconcile.ts
   ```

3. The script considers only containers with `foundry.interview-execution=true`, a matching `foundry-run-...` name, a valid container ID, and a creation age strictly greater than ten minutes. Future/invalid timestamps, young containers, unrelated labels and other names are excluded. Inventory is capped at 200; each mutation batch at 50. Apply explicitly after reviewing the safe counts:

   ```sh
   FOUNDRY_ORPHAN_RECONCILE=1 node --conditions=react-server --import tsx scripts/operations/reconcile.ts --apply
   ```

4. Eligibility is rechecked immediately before each forced removal. No broad prune, volume deletion, image deletion, or unrelated Docker change occurs. Failed inspection/removal exits nonzero; keep admission closed and investigate the daemon/host. Repeat bounded batches as needed. Young containers are retained by this script; keep the hold until the investigation/grace window resolves them.
5. Verify no abandoned labeled container remains. An authorized operator can clear the shared `execution_admission` row through `setExecutionAdmission(db, false, null)` using the trusted server connection, then reset/restart affected workers. The reconciler deliberately does not clear database holds automatically.
6. Confirm a fresh worker heartbeat and strict readiness, then run a harmless synthetic canary before reopening admission. Retain safe incident timestamps/counts and the relevant image/revision; inspect learner content only through a separately authorized support process.

Run reconciliation from a supervised operator job at a documented interval on each execution host. No scheduler was installed by this work. A worker process crash or daemon outage can prevent normal timeout cleanup; until a separate daemon-side watchdog is implemented, such a container may remain until reconciliation. The ten-minute eligibility grace is an operational recovery bound, not a claim that host failure preserves the ordinary 60-second deadline.

Local dry-run qualification found zero labeled execution containers and made no deletions. Unit tests verify label/name/age exclusions. Destructive removal of an aged real orphan was not staged on the developer machine; rehearse that incident in staging before broad beta.

## Incident and alert ownership

These are proposed initial alert rules; no monitoring provider or pager was configured here. Route each to the named role and validate thresholds in staging.

| Signal | Initial action/threshold | Owner |
| --- | --- | --- |
| Save/storage errors | Any sustained 5xx/save-acknowledgement failure; investigate storage before retrying mutations with new keys | Platform on-call |
| Queue age/worker freshness | Oldest queued job above 60 s or no fresh heartbeat for 90 s; check leases and worker capacity | Platform on-call |
| Cleanup unconfirmed | Page immediately, hold execution, reconcile dedicated runner host | Platform/security responder |
| Expired leases | Investigate repeated takeovers and fencing; never publish stale worker output | Platform on-call |
| Provider throttling/refusals/uncertain spend | Disable affected expensive feature if necessary, preserve authored fallback, inspect safe usage metadata | AI lead |
| Missing coaching report | Inspect durable job/generation state and offer bounded retry against the same frozen evidence | AI lead/support |
| Deletion backlog | Investigate incomplete cleanup inventories and provider copies under retention policy | Privacy/platform owner |
| Payment reconciliation failure | Keep grants/usage idempotent; inspect verified event inbox without raw payment payloads | Commerce owner |

`operationalCounters(db)` exposes aggregate queued/running/expired jobs, oldest queue age and incomplete deletions to trusted operator tooling. It is not exposed by public health. Correlate safe operation/job/provider IDs, timings, token counts and status categories in restricted logs. Exclude source, transcript, raw audio, private report text, access tokens, connection strings and raw provider error bodies. Ordinary learner assertion failures are task observations, not pager incidents.

## Backup, restore and rollout runbook

The design's proposed beta RPO is 24 hours and RTO eight hours. They are targets, not established results. Configure encrypted backups, restricted access, retention/backup expiration and provider recovery support separately. Rehearse restoration into an isolated environment and verify accounts, acknowledged snapshots, evidence/manifests, report generations, ledger uniqueness, deletion tombstones and entitlement reconciliation. The disposable smoke checks session/snapshot restoration only; it is not a complete hosted disaster exercise or point-in-time recovery qualification.

Before a release, record Git revision, ordered migrations, scenario/rubric digests, model/prompt/schema versions, approved runtime image IDs, feature flags, test/evaluation summaries and unresolved gates. Apply additive migrations before new readers/workers. Test migration grants and rollback compatibility on disposable/staging data; do not run `deploy/disposable-auth.sql` outside qualification. Back up and verify migration execution through the deployment's approved database workflow. Destructive schema rollback should be replaced with an additive repair where possible.

Deploy web and worker images separately, initially to staff. Drain workers gracefully before replacement; the Compose recipe allows 90 seconds for bounded execution/cleanup. Database state survives process replacement, and request keys/CAS/fencing prevent blind duplicate mutations. Roll back application images only to a version compatible with deployed schema and preserved scenario versions. Retire a new scenario from admission while retaining packages needed by existing attempts. Keep AI, execution, voice and paid admission independently controllable; disabling a feature must preserve acknowledged work.

Before public beta, complete the pending AI/expert/learner gates in `docs/evaluation.md`, public-host runner review, hosted identity/RLS and recovery rehearsal, actual full-container launch checks, keyboard/screen-reader review, browser network recovery, cost/capacity measurements, production backup restoration, and alert delivery rehearsal. Local qualification narrows uncertainty; it does not satisfy those gates by itself.
