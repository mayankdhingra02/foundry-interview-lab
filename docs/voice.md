# Optional press-to-talk voice

This workstream provides bounded REST speech requests alongside the text interview. It does not implement a continuous conversation gateway. The feature is off by default, and passing fixture tests does not qualify a speech provider or browser microphone path for release.

## Learner interaction

New attempts default to text. Session setup persists the explicit `voice` boolean; absent preferences on historical attempts mean voice is off. Selecting voice does not authorize provider processing or activate an unavailable provider. Fresh voice setup requires an explicitly triggered three-second local microphone input check. That check uses an in-memory input-level meter, makes no recording or upload, closes the audio context, and stops every media track on completion, cancellation, timeout or unmount. Permission denial, silence or unsupported browser APIs preserve the Text option. Interrupted start retries keep the original request body and do not automatically repeat microphone access.

During the active debrief, the learner separately allows sending recordings and selected interviewer questions to Deepgram. Recording starts only after that choice and the browser's microphone permission. A recording stops at 60 seconds. The browser converts its in-memory recording to mono, 16 kHz, 16-bit PCM WAV; browsers that cannot decode and convert it show the text fallback. Configured voice before Finish coding is labeled as available during debrief rather than incorrectly described as unconfigured. Text-selected attempts and unavailable providers have distinct messages.

Transcription appears in an editable review field. **Use transcript** copies it to the existing message composer. Only the ordinary authenticated turns endpoint commits the learner's reviewed text to evidence. Discarding a transcript creates no learner turn. Choosing another role tab, leaving the workspace, or changing session lifecycle releases the microphone and interrupts pending speech/playback. Cancel and Stop controls remain available during processing and playback.

Question playback sends a stable interviewer turn ID. The server reads the corresponding recorded text; client-supplied text cannot replace it. A Stop action aborts the browser request or stops the audio element and releases its object URL. If a provider request has already started, cancellation can still consume its reserved budget.

## Server integration

The authenticated practice dispatcher calls:

```ts
handleVoiceRequest(request, actor.id, sessionId, 'transcribe' | 'speak')
```

The helper also checks same-origin mutation policy and POST method. The dispatcher must verify the actor first. Before parsing the recording and again atomically during quota admission, the helper requires ownership, persisted `configuration.voice === true`, an active code-frozen debrief, and no final evidence freeze. Neither browser equipment-check state nor a claimed `consent` field can bypass these checks. Each provider operation still requires its separate explicit processing consent.

The creation API preserves `voice` only when it is a boolean. Default/explicit false are the same text admission identity, so pre-upgrade creation retries that previously had false stripped remain replayable. True is distinct: a retry cannot silently upgrade an old text attempt whose unsupported true field was previously stripped. New creations normalize the saved preference to false or true. The optional typed field and existing configuration JSON allow old records to remain readable without a data migration.

| Route | Required input | Success |
| --- | --- | --- |
| POST sessions/:id/voice/transcribe | Multipart: one `audio` file, `consent=true`, unique `requestId` | JSON `{text, source:"transcribed"}` |
| POST sessions/:id/voice/speak | JSON `{turnId, consent:true, requestId}` | `audio/mpeg` bytes |

An optional `text` property on speak is supported for contract compatibility only when it exactly equals the stored interviewer turn. A learner turn, missing question, or arbitrary text is rejected before a provider call.

The audio endpoint accepts only a canonical 44-byte WAV header and its PCM data, not WebM, MP4, remote URLs, or arbitrary compressed uploads. Header sizes, format, channel count, sample rate, block alignment and data length must agree. Duration is calculated from PCM bytes; a browser's claimed duration is never used. Capture is bounded to 0.1–60 seconds and 1,920,044 bytes. The entire multipart request is bounded to that size plus 16 KiB, including uploads without Content-Length. Parsing occurs only after the stream has passed the limit.

TTS accepts at most 1,500 UTF-16 code units of recorded question text. It requests MP3 at 48 kbps. The response is limited to 1 MB, parsed as complete MPEG Layer III frames, and rejected above 120 seconds or if malformed. Provider calls and response reads have timeouts. Provider errors return a safe text fallback without exposing provider bodies or learner content in logs.

## Atomic admission and failure semantics

`VoiceService` reserves before each provider call through `PracticeStore.transaction`. The PostgreSQL adapter takes the same transaction advisory lock used by session and AI operations; development File/Memory stores serialize the same callback. No nested store transaction or separate PostgreSQL write is used during admission.

Admission checks:

- Ownership, saved voice opt-in, active code-frozen debrief, unique owner-scoped request key.
- Per-session lifetime, per-user UTC-day, and global UTC-day allocated voice minutes. A cumulative session counter preserves its limit after old ledger rows expire.
- Session committed spend, user UTC-day/month ledger spend, and global UTC-day ledger spend, including existing AI commitments. Voice shares AI's `MAX_MONTHLY_USER_USD` setting.
- At most two pending speech requests per user and 32 globally.

STT allocates its verified capture duration. Each TTS request allocates the full two-minute playback allowance, even for a shorter question. Allocated minutes are deliberately conservative quota units, not a measurement of actual speaking time. Failed or interrupted requests do not refund those minutes.

The shared usage ledger receives a reservation with bounded content-free voice metadata, followed by a settlement or uncertainty posting. The metadata contains an operation key, request key, request-identity fingerprint, durations/character counts and reserved amount. It contains no audio, audio fingerprint, question text, transcript, or provider error body. Costs are rounded upward to eight decimal places. A successful operation moves its configured reservation from reserved to spent; an ambiguous outcome moves it to uncertain. There is no automatic refund or provider retry.

A repeated request key returns a conflict and cannot invoke the provider again. Speech output is ephemeral and cannot be replayed through idempotency records. If the response is lost, the learner can continue in text or explicitly initiate a new, separately admitted recording/playback. Do not transparently retry a timed-out POST.

If an attempt is deleted, becomes inactive, or no longer permits voice while a request is running, the result is discarded. Settlement retains the actual settled/uncertain accounting and never recreates a deleted attempt. Deleting practice content retains limited usage counters so it cannot reset spend/minute caps. Ledger expiry metadata is 62 days in the shared adapter; deployment cleanup and recovery procedures must be qualified. Abandoned reservations remain conservative commitments and need operator review; they are not silently released by elapsed time.

## Configuration and qualification

`voiceAvailability()` returns true only when all required values are valid. Production additionally requires DATABASE_URL. The environment must explicitly include:

```dotenv
FEATURE_VOICE=false
VOICE_QUALIFIED=false
DEEPGRAM_API_KEY=
VOICE_STT_USD_PER_MINUTE=0.0043
VOICE_TTS_USD_PER_1K_CHARS=0.03
VOICE_MAX_SESSION_MINUTES=20
VOICE_MAX_USER_DAILY_MINUTES=60
VOICE_MAX_GLOBAL_DAILY_MINUTES=600
MAX_SESSION_USD=1
MAX_DAILY_USER_USD=5
MAX_MONTHLY_USER_USD=50
VOICE_MAX_GLOBAL_DAILY_USD=50
```

These rates and limits are examples for operator review. The code refuses rates below the verified public baseline for its fixed model choices. Verify account-specific terms, applicable taxes, request units and any add-ons before selecting reservation ceilings. VOICE_QUALIFIED is an operator declaration, not the result of automated tests. Do not set either enabling flag during fixture validation.

Before enabling public voice, apply migration 0004 after foundation/runtime migrations; qualify actual service-role persistence, concurrent quota admission, request-timeout/crash handling, and counter retention. Verify the selected Deepgram account's opt-out in its usage logs and ensure infrastructure never logs request bodies. Test real microphone capture, resampling, playback, cancellation and transcript correction across supported browsers and accessibility settings. Test an actual supported MP3 response against the strict parser. Evaluate accents, technical vocabulary and transcription failures with representative consenting learners. This implementation has made **no paid or live speech calls**, so those provider/browser quality gates remain open.

The existing health/capability API should use `voiceAvailability()`, not merely the existence of a speech API key. Keep text participation available when voice is unavailable or its quota is exhausted.

## Provider contract and retention

The adapter uses Nova-3 English prerecorded STT with binary WAV, and Aura-2 Thalia English TTS with JSON text. The official REST references specify Token authorization, STT `/v1/listen`, and TTS `/v1/speak`; the implementation pins those endpoints rather than accepting a client URL. [D1][D2]

Every STT/TTS request includes `mip_opt_out=true`. Deepgram documents model improvement participation by default, opt-out for these APIs, and no retained audio/text/transcripts/synthesized audio after opted-out responses. Request metadata and usage logs remain; the provider describes logs retained for 90 days with summarized usage beyond that. Confirm the account's actual controls before making a product retention guarantee. Interview Lab does not persist raw or synthesized audio; in-memory processing and provider handling still occur. [D3]

As checked on 2026-10-09, public PAYG prices are $0.0043 per minute for monolingual Nova-3 prerecorded STT and $0.030 per 1,000 characters for Aura-2. Thus a 60-second capture reserves $0.0043 and a 500-code-unit question reserves $0.015 at those configured rates. Public per-second STT billing includes silence without rounding up a recording to a minute. These are bounded input calculations, not verified account invoices. [D4]

Deepgram's March 5, 2026 changelog says PAYG/Growth customers can opt in or out of model improvement without changing the public pricing rates. Enterprise terms may differ. [D5]

## Tests and deferred work

`tests/voice.test.ts` uses mocked HTTP responses to test saved opt-in, historical defaults, active debrief gating, consent, ownership, waveform validation, streamed size limits, saved-question playback, transcript non-persistence, uncertainty, duplicate admission, selection/deletion races and simultaneous limits across all scopes. `tests/practice-api.test.ts` covers creation/export persistence, schema validation and pre-upgrade text replay compatibility. Fixtures test deterministic contracts; they do not establish provider quality. Browser equipment tests use fake local media APIs and do not qualify real microphones, supported browsers or speech providers.

`RUN_POSTGRES_INTEGRATION=1 npx vitest run tests/voice-postgres.integration.test.ts` creates a fresh local disposable Docker database, applies migrations 0001/0002/0004/0007/0008 and uses the actual service-role grants. It tests persisted voice choices, pre-debrief/text/legacy denial, cross-adapter atomic admission, ledger roundtrip, deletion-resistant counters and database metadata constraints. It never reads a hosted DATABASE_URL or calls Deepgram. The new selection/gating regression requires fresh CI qualification; no local Docker or live speech call was made for this change.

A LiveKit/full-duplex gateway, authenticated short-lived connection tickets, continuous STT, interruption-aware server turn detection, streaming TTS, reconnect reconciliation and coordinated cancellation remain a later workstream. There is no placeholder WebSocket endpoint or claim that press-to-talk implements those requirements.

## Official sources

All checked 2026-10-09. Paraphrases above are intentionally short.

- D1: Deepgram prerecorded REST reference — https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
- D2: Deepgram single TTS request — https://developers.deepgram.com/reference/text-to-speech/speak-request
- D3: Deepgram data handling — https://developers.deepgram.com/trust-security/your-data
- D4: Deepgram pricing — https://deepgram.com/pricing
- D5: Deepgram MIP pricing update — https://developers.deepgram.com/changelog/2026/3/5
