# Learner interview controls

Working, repeat and clarification are deterministic controls available during an active coding attempt or debrief. They create `interview.interaction` events, rather than scored learner utterances. They do not call a model, reserve spend, reveal protected checks or reference files, or count toward interviewer question coverage.

`POST /api/interview-practice/sessions/:id/interaction` accepts `requestId`, `expectedRevision`, `action: working | repeat | clarify` and, for clarification only, an optional `topic: requirements | assistance | timing`. Ownership comes from the signed-in identity. Strict bounded JSON, same-origin writes, revision checks and durable request fingerprints apply. The response contains the acknowledged session, authored response and an optional repeated question ID. There is a limit of 100 committed controls per attempt.

Working records the learner's status without pausing, submitting an answer or changing a checkpoint. Repeat returns the exact latest committed interviewer question without adding another turn. It is unavailable before any question exists. Clarification uses only the public scenario summary and current stage requirements, or the saved assistance/timing policy. Freeform solution requests continue to belong to the separately permitted coding assistant.

The workspace saves pending file edits before using a control, retains a request key across interrupted retries, and shows the latest acknowledged response after refresh. Before debrief, it offers these controls instead of a misleading answer composer. During debrief, finalized typed or corrected speech answers remain separate evidence. Controls close after final submission or while the attempt is paused. No mastery, personality or communication judgment is inferred from their use.

Six domain regressions cover frozen evidence, ownership, stale revisions, idempotent replay, exact question repeat, policy and lifecycle constraints. A dispatcher test verifies owner-only HTTP wiring. The browser journey covers transport retry, refresh persistence and narrow-screen controls without executing learner code or calling a provider.
