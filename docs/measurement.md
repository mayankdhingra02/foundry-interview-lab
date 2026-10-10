# Optional practice measurement

Measurement is off by default. It describes product use and latency; it does not change execution evidence, feedback, skill progression, quotas or mutation recovery. There is no PostHog SDK, hosted collector, production dashboard or learning-impact result in this patch.

## Configuration and delivery

Enable only after approving the deployment's logging access and retention policy:

```dotenv
FEATURE_PRACTICE_TELEMETRY=true
PRACTICE_TELEMETRY_SINK=stdout
PRACTICE_TELEMETRY_SECRET=<a separate random secret of 32–256 characters>
```

Missing or invalid configuration disables emission and the browser capability. Use a separate secret from authentication/provider credentials. Records use channel `foundry.practice.telemetry` and schema version 1. A deployment may route that channel to a reviewed analytics collector, including PostHog, but no such integration has been qualified. Do not enable provider autocapture, session replay or arbitrary property collection through this interface.

Emission is best effort. A throwing sink cannot roll back an acknowledged save or accepted worker result. There is no transactional outbox, durable diagnostic queue or delivery guarantee: process failure after a durable mutation can lose its observation. Replayed durable mutation facts have stable HMAC event IDs for collector deduplication; records can repeat. Worker queue observations describe individual fenced claims, including reclaimed work, rather than unique jobs. Successful result observations require an accepted fenced completion. Latency samples describe individual observations, not exactly-once business counters.

## Facts and observations

| Event | Origin and interpretation |
| --- | --- |
| `practice.started` | Exact durable `session.started` event from the authenticated creation mutation; practice or simulation mode only |
| `practice.submitted` | Exact durable submission event; not proof that a report succeeded |
| `assistance.requested` | Exact durable assistant admission and its ask/plan/edit enum; not successful inference |
| `focused-drill.completed` | Exact durable drill event, explicitly a learner self-report |
| `feedback.opened` | Owned report selected in the browser; always `browser-unverified`, not proof it was read |
| `unseen-retest.completed` | Accepted coaching result followed by a deterministic saved-history sequence check; explicitly `saved-history-only` |
| `latency.measured` | Enumerated boundary, bounded duration and outcome; compare only like origins, metrics and boundaries |

An unseen retest requires a completed, reported fresh attempt with frozen evidence, no retained earlier same-family attempt, and an earlier completed attempt with a genuinely recorded suggested drill matching an observed gap through the authored progression map. A different variant in the same family is repeated practice. Strong/unobserved criteria, arbitrary completions and unrelated drill events do not qualify. Deleted attempts, off-platform exposure and actual drill performance remain unknown. Publication and drill chronology are additionally enforced as specified in [measurement-chronology.md](measurement-chronology.md); later reports cannot retrospectively create this event. This event establishes a sequence; it does not establish improvement, causation, mastery or interview readiness. Actual learning evaluation still requires independently reviewed outcomes and a learner pilot.

## Server latency boundaries

| Metric | Boundary |
| --- | --- |
| `workspace.save` | HTTP handler immediately before bounded body parsing through successful service acknowledgement; excludes authentication, learner typing and transport |
| `job.queue` | Durable job creation timestamp through successful lease claim; includes time before a later reclaim |
| `sandbox.provision` | Successful Docker create command through its acknowledged completion for each suite; excludes image pulls and container start/execution, and is not a ready-to-run or remote-host provisioning SLO |
| `run.result` | Durable job creation through accepted run completion or accepted failure |
| `text.turn` | Durable interviewer job creation through accepted completion or accepted failure; not visible-question time |
| `report.ready` | Durable coaching job creation through accepted report completion or accepted failure |

Workspace timing uses a monotonic process clock. Queue/result timing uses persisted wall-clock timestamps; deployment clock skew can invalidate samples. Invalid, negative, nonfinite or over-one-hour durations are dropped, including long recovered jobs. Successful create observations do not cover failed create attempts. A test failure with a completed run is an acknowledged result; infrastructure failure is a failed sample. Fenced/stale completion rejection supplies no accepted-result metric. Assistant admission has a product fact and queue observation but no separate result-latency metric.

Browser boundaries and speech limitations are specified in [browser-measurement.md](browser-measurement.md). Browser and server samples for the same metric are different distributions. The press-to-talk review/submit/play flow does not emit `voice.answer-to-audio`; manual waits make an end-of-speech claim invalid. Real voice usability, provider/network percentiles and supported-device measurements remain unqualified.

## Privacy, ownership and bounds

Strict schemas allow enums, duration/outcome values, mode and explicit provenance only. They reject code, files, paths, answers, transcripts, audio, free-form errors and arbitrary property bags. Collector records use HMAC actor/session/event/job tokens, with no raw account, session, job or report IDs. These tokens are linkable pseudonymous data, not anonymous data. Timestamps and activity sequences can also identify a person in a small cohort. Rotating the secret breaks future linkage; it does not erase existing records.

Browser ingress requires same-origin authenticated POST and an owned session; report/job IDs are checked against that session. The server assigns `browser-unverified`, rejects server-only queue/provision metrics and never promotes observations into evidence. Bodies are streamed and bounded at 600 bytes. One process admits at most 1,000 active owners, 30 observations per owner per minute and 300 recent event IDs per owner; ten-minute caches are memory only. Shared ingress limits across replicas require deployment configuration. Browser helper limits and dropped-span behavior are documented separately.

No diagnostic record is added to session export or the practice store. Consequently session/account deletion does not automatically erase already emitted log records. Before enabling, document and implement collector retention, access controls, token lookup/deletion or an explicitly disclosed limited retention policy, and ensure ordinary ingress logs do not retain request bodies or unredacted identifiers. Existing [retention.md](retention.md) applies to practice storage, not an unconfigured external collector. A hosted collector and its deletion policy remain release work; default-off measurement is the safe development configuration.

## Verification and remaining qualification

Deterministic tests exercise strict content exclusion, HMAC identities, duplicate/rate bounds, ownership and correlation, feature-off silence, sink failures, unchanged durable session state, sequence classification and accepted versus stale worker results. Intercepted browser checks exercise acknowledgement/render boundaries and quota recovery, including repeated identical speech transcripts. These fixtures make no real model, speech, Docker, analytics or payment calls. Fresh CI must qualify the focused commit separately.

Before enabling for users: approve the collector and data policy, configure cross-instance ingress protection, verify emission/deduplication and deletion in the chosen deployment, establish real percentiles with the documented boundaries, and obtain independent learning/pilot evidence. No synthetic test or completion count closes those gates.
