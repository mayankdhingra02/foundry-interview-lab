# Practice API and worker

All private routes use the verified actor. Hosted mode requires Supabase identity and PostgreSQL; signed local identity and file storage are development-only. Mutating browser requests require the configured APP_URL origin and bounded JSON. Public catalog DTOs omit reference solutions, probe/hint banks, and protected check source.

The namespace is `/api/interview-practice`. Sessions, workspace saves, commands, turns, runs, assistant requests, edit decisions, hints, drills, report retries, exports and deletion are implemented by the typed SessionService. Creates return201; admitted background work returns202 with a durable job; acknowledged synchronous mutations return200. Errors use `{error:{code,message,revision?}}`; stale revisions and changed request fingerprints return409.

Every mutation carries a unique requestId. Revisioned mutations also carry expectedRevision. Replaying an identical owner/key returns the original acknowledged result. A fresh read can have a newer revision because another tab or a worker advanced the session. Workspace files are allowlisted and bounded; accepted assistant edits must match their admitted base snapshot. Finish coding freezes code; Final submit freezes the complete evidence, including later debrief answers. Pending evidence work must finish or be cancelled first.

`GET /sessions/:id/events?after=sequence` supports JSON replay and finite SSE when Accept includes text/event-stream. SSE sends only committed events with sequence IDs, honors Last-Event-ID, closes after20seconds, and rechecks ownership/existence while connected. Clients reconnect and deduplicate by sequence. Generated partial model text is never authoritative evidence.

Owner exports include all acknowledged snapshots, test facts, confirmed turns, reports and evidence. Worker claim tokens, owner identifiers, privileged job inputs and provider diagnostics are omitted. `DELETE /api/account` removes Interview Lab content while preserving shared Foundry sign-in. Content-free usage/admission counters remain for capped operational retention; deletion must not reset spend or paid allowances. Raw audio is not stored.

## Worker

Run `npm run worker` in a separate persistent process for hosted deployments. It loads local environment only when present, leases durable work, heartbeats its claim, pins admitted inputs and fences stale results. Development also drains jobs opportunistically in the web process. No network/provider calls occur inside a practice-store transaction.

Reservations enforce session, daily/monthly account and global daily spend ceilings. Known rejected-output usage is still settled; ambiguous external calls retain conservative reservations. Exhausted quota does not prevent saving or completing an attempt: debrief/report jobs can use authored questions and explicitly unassessed reports. AI assistance and new billable work remain blocked.

`tests/practice-api.test.ts` verifies ownership, redaction, fingerprints, revisions, SSE and exports. `tests/worker.test.ts` verifies admitted-snapshot processing, deletion during inference, global atomic quota and the non-billable completion path. Provider fixtures are deliberately synthetic; genuine Docker, PostgreSQL and browser checks are documented separately.
