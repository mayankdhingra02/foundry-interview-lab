# Browser measurement and quota recovery

Browser observations are optional diagnostics. They run only when the authenticated workspace exposes `capabilities.telemetry === true`; absence or false makes no observation request. The server flag remains off by default. The browser uses a dedicated `POST /api/interview-practice/sessions/:id/observations` request, rather than instrumenting the general API helper. The server validates ownership and job/report correlation and records these as `browser-unverified`. They never become execution evidence, skill facts, readiness scores, or provider timing claims.

## Measurement boundaries

| Metric | Start | Successful end | Meaning and exclusions |
| --- | --- | --- | --- |
| `workspace.save` | Immediately before the actual workspace PUT | Acknowledgement processed successfully | Browser transport and server acknowledgement; excludes typing and the autosave debounce. |
| `text.turn` | Immediately before a fresh confirmed-answer POST | The correlated interviewer question is committed in the active interviewer panel | Includes request transport, queue, processing and polling. Text may be typed or a reviewed transcript. Excludes composing/reviewing the answer; an interviewer job that chooses no further question supplies no question-visible sample. |
| `run.result` | Admission response supplies the job ID | A run with that job ID is rendered | Includes queue, execution and polling after admission. An infrastructure/timeout result is still an acknowledged result, not a passing check. A job failure or cancellation is separately labeled. |
| `report.ready` | Submit/retry admission response supplies the job ID | The report linked by that job's `coaching.ready` event is rendered | Includes queue, coaching and polling after admission. An admission rejection supplies no admitted-job sample. |
| `voice.transcribe` | Immediately before explicit or bounded automatic recording stop | The transcript review is committed | Includes recording finalization, local WAV conversion, upload and transcription. It excludes recording duration and the learner's later correction/review wait. |
| `voice.playback` | An explicit Play action begins its request | The browser's `audio.play()` promise resolves | Includes synthesis download and browser playback startup. It is not network-only TTS or end-of-speech latency. Explicit stop/failure before startup is labeled accordingly. |

Here “rendered” means committed in the learner UI, not proof that the person read it or that every item was simultaneously within the viewport. Question measurement waits while the coding-assistant tab hides the question. A report-open observation identifies a selected report UUID once per mounted report view, including explicitly selected earlier versions; it does not infer learning or satisfaction.

The optional `voice.answer-to-audio` metric is deliberately not emitted. This press-to-talk flow requires transcript review, explicit answer submission and explicit question playback. Manual playback can add an arbitrary learner delay after the question appears, so it cannot provide a defensible automatic answer-to-audio or end-of-speech measurement. Full-duplex measurement and hardware/provider latency qualification remain separate future work. Sandbox provisioning timing is server-owned, not inferred from a browser's run duration.

## Content and delivery bounds

Every browser payload passes the strict shared `BrowserObservation` schema: UUID event ID, a metric enum, finite nonnegative duration up to one hour, an outcome enum and optional job UUID; feedback-opened uses only the event/report UUIDs. Code, paths, learner text, transcripts, errors, audio, account IDs and arbitrary property bags are not sent. Session identity appears only in the authenticated endpoint path. The server derives its own origin and pseudonymous collector identities; a browser cannot upgrade itself to a server fact.

The helper keeps spans/correlation only in memory. It does not add local/session storage, a durable queue, keepalive delivery or automatic retries. Reload/navigation drops unfinished measurements without changing the existing durable learner-action recovery. A recovered mutation does not pretend to retain a timing span lost on refresh. A fresh failed answer transport can produce a failed timing sample, while its real action remains uncertain under the existing recovery policy.

Each mounted helper allows at most four concurrent observation requests, 30 sends per minute, 20 tracked jobs and 100 report-open IDs. Requests abort after five seconds; disabling the capability/unmounting aborts outstanding diagnostics. Bodies are limited to 1,024 characters after schema validation. Negative, invalid, nonfinite and over-one-hour spans are dropped rather than clamped into misleading samples. Server ingress independently bounds authenticated observations. An unavailable/rejecting collector produces no learner error or blocking wait, and no retry follows.

## Quota exhaustion behavior and evidence

`tests/e2e/telemetry-quota.spec.ts` intercepts all HTTP and uses explicit synthetic microphone/conversion/playback fixtures. It verifies feature-off silence, acknowledgement/result timing boundaries, job/report correlation, content-free schema, speech phase boundaries and observation failures that do not block saves. These are UI/transport-contract checks, not real-provider performance claims.

The same suite verifies run quota preserves implementation saved before admission; AI quota keeps the unsent assistant message and creates no synthetic reply; report quota remains visible in its open confirmation and preserves the debrief; speech quota keeps the question and typed answer usable in text. A definitive first 429 clears only that rejected logical intent, allowing a later explicit action to obtain a new key. A 429 while recovering an already-uncertain request preserves its exact body/key across refresh; no replay occurs until the learner presses Recover. The fixture records one admission across the interrupted/retried journey.

`tests/browser-measurement.test.ts` verifies one-hour/invalid-clock rejection, single completion per span, request concurrency/rate/time bounds, collector failure without replay and disabling the capability. No test in this patch consumes provider, runner, speech or payment capacity. Real deployment percentile measurements, successful speech from supported devices, production collector retention/access policy, cross-instance ingress limits and human learning evaluation remain external qualification work.
