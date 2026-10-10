# Configured model providers

Foundry has two normalized inference transports: `openai-responses` and `anthropic-messages`. `AI_PROVIDER` selects exactly one for new admitted work and defaults to OpenAI. Anthropic is configured as a second adapter with a separate default-off gate. **There is no automatic fallback or cross-provider retry.** This implements the configure-now portion of design §15; enabling automatic fallback remains conditional on the same role-specific quality, failure, cost and retention benchmarks. Authored neutral probes and observation-only reports are deterministic recovery, not a second model provider.

## Configuration

| Setting | OpenAI Responses | Anthropic Messages |
| --- | --- | --- |
| `AI_PROVIDER` | `openai-responses` (default when unset) | `anthropic-messages` |
| Server credential | `OPENAI_API_KEY` | `ANTHROPIC_API_KEY` |
| Provider-specific gate | Credential availability | `FEATURE_ANTHROPIC_INFERENCE=true` and credential availability; otherwise disabled |
| Requested model | `OPENAI_MODEL`; existing baseline `gpt-5.4-mini` | `ANTHROPIC_MODEL`, required explicitly |
| Input/output rates | `OPENAI_INPUT_USD_PER_MILLION`, `OPENAI_OUTPUT_USD_PER_MILLION`; existing baseline inputs apply only to the baseline model | `ANTHROPIC_INPUT_USD_PER_MILLION`, `ANTHROPIC_OUTPUT_USD_PER_MILLION`, both required explicitly |
| Common limits/gates | `AI_MAX_OUTPUT_TOKENS`, `FEATURE_AI_INTERVIEW`, independent `FEATURE_REPORT_GENERATION`, existing quota/reservations | Same common controls, plus the Anthropic gate |

An unknown or malformed provider selection fails closed. Supplying an Anthropic key alone does not enable it. No Anthropic model name, account access, price or free tier is assumed. Confirm current standard uncached tariffs, model structured-output compatibility, account limits and approved data controls before an owner authorizes recording or admission. Rates are configured accounting inputs, not invoice guarantees. Keep credentials in private server configuration, never Git, browser settings or evaluation files.

New paid jobs capture the selected provider, requested model, role, prompt/schema/context versions, input/output/response/time limits, configured prices and reservation. Execution uses that immutable binding even after `AI_PROVIDER` changes. The admitted provider's current feature/credential shutdown controls still apply. Closing Anthropic's gate can stop queued Anthropic work; it does not redirect it to OpenAI. See [inference policy binding](inference-policy-binding.md).

## Transport and authority

The adapters normalize text, inert tool requests, completion/refusal state, usage, returned model and available request/response IDs. Both support cancellation and bounded response reading. The product grants neither provider tools. Any tool request is rejected as a role result and is never executed. Both transports use the same role-specific contexts, secret-minimization policy, strict server schemas, evidence/coverage checks and assistant edit policy. Reference solutions and protected check source remain outside model contexts; public source visibility is a separate exposure boundary.

OpenAI uses Responses structured output and `store:false`. Anthropic uses top-level `system`, a user message, bounded `max_tokens`, `anthropic-version: 2023-06-01`, `output_config.format` JSON schema and standard-tier requests. Anthropic's native schema format does not remove raw server validation. Refusals, incomplete output, malformed JSON and policy-invalid content never become accepted assessment output. Requests make no repair call or provider switch.

Anthropic accounting supports ordinary uncached standard-token usage with no tools. Unexpected cache creation/read, server-tool usage, nonstandard service tier or other unsupported billing meters leave the reservation uncertain; the recorder stops instead of reporting a guessed charge. Valid ordinary usage is priced using the captured rates even when the content is rejected. Cancellation or a network interruption can remain uncertain after a request has been sent. Returned aliases/snapshot names are recorded separately from the requested model.

The adapters do not establish zero retention or data residency. OpenAI's storage request is not an account-level retention promise, and Anthropic has no invented equivalent setting in this adapter. The chosen account terms, retention, region, invoice meters and access still need owner review.

## Operator evaluation

The existing development and private recorders use these actual production adapters. There is no separate evaluation-only Anthropic implementation and no new paid-recording flag. Select the provider through private environment configuration, then use the existing gates. A zero-call development plan can be inspected with:

```sh
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/benchmark-models.ts --cases money-starter --roles interviewer,coach,assistant-ask,assistant-plan,assistant-edit
```

The plan prints provider/model, planned role calls and conservative reservation. A private plan uses `scripts/private-model-evaluation.ts --corpus /absolute/private/corpus.json`, with existing capture/overlap options where required. Private artifacts remain outside Git under the documented permissions and exact corpus/split/context bindings.

Actual recording still requires `--record --acknowledge-paid-api --max-usd NUMBER --output NEW_PRIVATE_PATH`; the private path also requires its existing enable flag/operator and a separate custodian unlock for holdout. An illustrative command is not spending authorization. Each paid recording invocation captures its policy once, journals the full run and each reservation before a call, and cannot resume or overwrite prior work. A plan from an earlier invocation is informational; the recording journal is the authoritative admitted policy for its invocation. Run each provider into a distinct new artifact with unchanged contexts to compare candidates.

Both recorders include the bound provider in new policies and inference provenance. Offline review uses recorded settings, never current prices/provider configuration. Historical OpenAI artifacts without a provider field stay readable as OpenAI. Anthropic artifacts require their captured bindings; changed/missing provider provenance is rejected. The existing independent [role review](role-review.md) and [private review](private-model-evaluation.md) workflows remain required. Cost/latency comparison, valid JSON and model agreement do not supply expert truth, protected holdout custody, content display approval or a release decision.

## Evidence boundary

The prior main checkpoint `3bff37b` passed all four CI jobs; it predates this adapter. Focused new evaluation tests intercept HTTP for all five role tasks in both corpus paths, exercise selection drift and uncertain billing, and preserve legacy reads. They make no paid calls. This change supplies no real Anthropic/OpenAI output, reviewer labels, new curated acceptance cases, live latency/invoice data or automatic-fallback qualification. Before enabling the new provider for learners, record owner-authorized candidates, complete independent review for interviewer/coach/all assistant modes, qualify account failures/cancellation/usage and data handling, and record the deployment's exact-head checks.

Protocol references: [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [Messages creation](https://platform.claude.com/docs/en/api/messages/create), [API errors and request IDs](https://platform.claude.com/docs/en/api/errors). Evaluation practice follows task-specific datasets and independent human calibration; see [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices). These references describe provider interfaces and methodology, not measured Foundry quality.
