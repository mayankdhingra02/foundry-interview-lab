# Model orchestration

The interviewer, coding assistant and coach use separately constructed contexts and strict JSON schemas through the OpenAI Responses API. They have no tools. The assistant receives admitted workspace files and public checks; neither it nor the interviewer receives reference solutions or protected test source. The coach interprets a frozen evidence manifest. Learner-controlled material is quoted data in every role.

The server validates schema, scenario/criterion/probe/drill IDs, evidence references, coverage and bounded question counts. Final reports require every criterion exactly once; unobserved explanations and optional AI non-use cannot receive invented findings. A narrow deterministic test-claim check rejects universal pass/fail claims unsupported by the final snapshot. These checks cannot establish semantic truth or educational usefulness; expert and adversarial qualification remains necessary.

Invalid interviewer output falls back to an authored neutral probe; invalid/unavailable coaching produces an explicitly unassessed observation-only report. The assistant fails visibly rather than fabricating help. There are no automatic inference retries or repair calls. Interrupted calls retain uncertain cost reservations. Known usage is settled even when the generated result is rejected. Model-request IDs, requested/returned models, prompt version, token counts, timing and validation outcome remain in private job diagnostics; learner job DTOs omit them.

## Configuration and costs

`OPENAI_API_KEY` stays on the server. `OPENAI_MODEL` defaults to `gpt-5.4-mini`; any override must supply both price variables. `OPENAI_INPUT_USD_PER_MILLION`, `OPENAI_OUTPUT_USD_PER_MILLION` and `AI_MAX_OUTPUT_TOKENS` drive conservative admission reservations. The baseline values are planning inputs, not a guarantee of invoice cost. Cached inputs are conservatively priced as uncached. Recheck account access and current prices before enabling live inference.

Every newly admitted inference job captures its role, requested model, prompt/schema/context versions, request limits, configured rates and reservation in an immutable policy binding. Workers and report retries use that binding; a later environment change cannot silently select another model or price for the same generation. Completion checks stored admission against the recorded inference and returned model. Unsupported or legacy unbound jobs cannot call a provider: interviewer/coach jobs use the deterministic authored fallback, and assistant jobs fail visibly. Current global/report switches are still checked before inference. See [inference policy binding](inference-policy-binding.md) and [evaluation recording policy](evaluation-policy-binding.md).

Interviewer JSON input is capped at 24 KB and assistant/coach at 64 KB. Admission estimates a conservative maximum using one token per UTF-8 byte plus 8,000 instruction/schema tokens and bounded output; an existing role reservation floor may reserve more. Evidence packaging prioritizes final code and actual test facts, marks excerpts and counts omitted evidence. Large assistant workspaces can exceed the input bound and fail without calling the provider; saving and deterministic execution remain available.

Requests set `store:false`, use a 40-second deadline and carry no product/account tools. This does not promise zero provider retention. Review the provider's current data controls and account-specific terms before production.

## Verification boundary

`tests/ai.test.ts` verifies role material separation, strict schemas, refusal/invalid-output handling, evidence/coverage checks, cost settlement and private diagnostics using mocked HTTP responses. It does not establish live quality, latency, provider access or learner benefit. `evals/` tracks the independent qualification work separately.

## Best-effort input minimization

Before a model request, recognizable API tokens, password-bearing database URLs and PEM private-key blocks are replaced with a marker. Evidence IDs and original private artifacts remain unchanged. This narrow scrubber cannot detect every secret or personal detail. Complete assistant file edits are blocked before inference when such material is found, since proposing replacements over a redacted file could silently erase it; the learner receives an actionable saved-work message.
