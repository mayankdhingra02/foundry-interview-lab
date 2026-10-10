# Admitted inference policy

Queued model work must execute the policy for which its spend was reserved. `lib/ai/binding.ts` captures a versioned immutable binding in each newly admitted interviewer, assistant or coach job. It contains the provider/role, requested model, prompt/schema/context versions, input and instruction allowance, output and response limits, timeout, configured token rates and conservative reservation. The job fingerprint includes the binding. It is persisted through the existing job runtime payload; no SQL migration or live-provider call is required.

## Admission and execution

The application resolves capabilities and configuration at each new admission. Disabled interviewer/coach admission records an authored-only job with no paid reserve; disabled assistant admission rejects the request. A paid admission reserves at least the binding's calculated maximum. Existing quota and request replay rules still apply.

Workers compare a claim with stored admission before calling the provider. They pass the stored binding through context construction, request limits, structured output and cost calculation. Report retries retain the original generation and binding. Changing environment model, prices or token limits affects future admissions; it cannot reinterpret a queued job or retry. Supported prompt/schema/context versions are checked against the installed implementation, so a deployment that cannot execute an old binding fails closed.

Global AI and coach-specific report gates are checked again before sending a request. Closing a gate can prevent a queued call; it cannot retract a call already sent. Reopening a gate does not upgrade an authored-only admission. Unbound legacy jobs and unsupported bindings never initiate inference: interviewer/coach work produces the canonical authored fallback, while assistant work fails visibly. Historical saved results remain readable.

## Completion and accounting

Provider completion must identify the captured binding, role, requested model and prompt/schema/context versions. The returned model is recorded separately because providers may resolve an alias to a snapshot. Accepted model output must agree with that returned identity and pass the existing role validation. Callers cannot label arbitrary output as authored: fallback output must equal the deterministic authored probe or observation-only report.

Known usage is calculated using the captured rates and settled even when output is invalid. Invalid output does not become a valid assessment. Usage above a requested output limit remains a billable observation when the provider supplied valid usage; malformed or missing usage retains uncertain spend. A failed assistant request cannot claim positive spend without matching bound inference provenance. Before retry or lease reclaim, private `attemptObservations` preserve prior usage/provenance or uncertainty, and current attempt fields are cleared. Historical queued metadata with no reliable reservation association is explicitly marked `legacy-unattributed`. The existing three-attempt limit bounds this history; malformed over-cap history fails closed instead of truncating observations. Private owner exports retain diagnostics; public learner job DTOs exclude them.

These configured costs are planning/accounting inputs, not an invoice reconciliation. Provider response IDs and usage are available only when actually returned. There are no automatic inference repair calls. Existing lease, cancellation, settlement and uncertain-reservation behavior continues to apply.

## Evaluation and verification

Controlled role recorders capture the same policy before reserving their run budget. Their journals keep the original binding, and comparisons validate recorded policy without consulting current environment prices. Legacy recordings without the optional binding remain readable; stripping provenance from a new bound recording fails validation. See [evaluation policy binding](evaluation-policy-binding.md).

Regression tests cover environment drift, persisted admission and claim mutation, exact authored fallbacks, requested/returned model provenance, bound-price settlement, invalid known-usage responses, and retry behavior. Mocked HTTP and synthetic fixtures verify software mechanics only. Actual account access, model quality, latency, retention, invoices, independent review and learner outcomes still require the separate qualification work.
