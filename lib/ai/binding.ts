import { z } from 'zod';
import { digest, DomainError } from '../interview-practice/domain';
import type { InferenceRecord, JobResult, PracticeJob, Scenario, Session } from '../interview-practice/types';
import { INPUT_BYTES, modelPolicy, type AiRole, type ModelPolicy, type ModelProvider } from './policy';
import { authoredQuestion, observationOnlyReport } from './authored';

export const PROMPT_VERSION = 'foundry-2026-10-09-v2';
export const SCHEMA_VERSION = 'foundry-structured-v1';
export const CONTEXT_VERSION = 'foundry-context-v2';
const bindingSchema = z.object({
  version: z.literal(1), provider: z.enum(['openai-responses', 'anthropic-messages']), role: z.enum(['interviewer', 'assistant', 'coach']),
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  promptVersion: z.string().min(1).max(100), schemaVersion: z.string().min(1).max(100), contextVersion: z.string().min(1).max(100),
  maxInputBytes: z.number().int().positive().max(64_000), instructionAllowanceBytes: z.number().int().positive().max(8000),
  maxOutputTokens: z.number().int().min(600).max(3200), timeoutMs: z.number().int().positive().max(40_000),
  maxResponseBytes: z.number().int().positive().max(128_000), maxOutputCharacters: z.number().int().positive().max(60_000),
  inputRate: z.number().finite().min(0).max(1000), outputRate: z.number().finite().min(0).max(1000),
  reserveUsd: z.number().finite().min(0).max(100),
}).strict();
export type InferenceBinding = z.infer<typeof bindingSchema>;
export function minimumReservation(binding: Pick<InferenceBinding, 'maxInputBytes' | 'instructionAllowanceBytes' | 'inputRate' | 'maxOutputTokens' | 'outputRate'>): number {
  return Math.ceil((binding.maxInputBytes + binding.instructionAllowanceBytes) * binding.inputRate + binding.maxOutputTokens * binding.outputRate) / 1_000_000;
}
/** A synchronous, server-only configuration capture; performs no provider calls. */
export function configuredInferenceBinding(role: AiRole, minimumUsd = 0): InferenceBinding {
  return inferenceBindingFromPolicy(role, modelPolicy(), minimumUsd);
}
export function inferenceBindingFromPolicy(role: AiRole, policy: Omit<ModelPolicy, 'provider'> & { provider?: ModelProvider }, minimumUsd = 0): InferenceBinding {
  const binding = { version: 1 as const, provider: policy.provider ?? 'openai-responses', role, model: policy.model,
    promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, contextVersion: CONTEXT_VERSION,
    maxInputBytes: INPUT_BYTES[role], instructionAllowanceBytes: 8000, maxOutputTokens: policy.maxOutput,
    timeoutMs: 40_000, maxResponseBytes: 128_000, maxOutputCharacters: 60_000,
    inputRate: policy.inputRate, outputRate: policy.outputRate, reserveUsd: 0 };
  binding.reserveUsd = Math.max(minimumUsd, minimumReservation(binding));
  const parsed = parseInferenceBinding(binding, role);
  if (!parsed) throw new DomainError('unavailable', 'The configured inference policy is invalid. Your saved work remains available.');
  return parsed;
}
export function parseInferenceBinding(value: unknown, role?: AiRole): InferenceBinding | null {
  const parsed = bindingSchema.safeParse(value);
  if (!parsed.success || role && parsed.data.role !== role || parsed.success && parsed.data.reserveUsd + 1e-9 < minimumReservation(parsed.data)) return null;
  return parsed.data;
}
export function compatibleInferenceBinding(value: unknown, role: AiRole): InferenceBinding | null {
  const binding = parseInferenceBinding(value, role);
  return binding && binding.promptVersion === PROMPT_VERSION && binding.schemaVersion === SCHEMA_VERSION
    && binding.contextVersion === CONTEXT_VERSION && binding.maxInputBytes === INPUT_BYTES[role] && binding.instructionAllowanceBytes === 8000
    ? binding : null;
}
export const inferenceBindingDigest = (binding: InferenceBinding) => digest(binding);
export function validateInferenceRecord(record: InferenceRecord, binding: InferenceBinding, actualUsd: number | undefined) {
  const usd = (record.inputTokens * binding.inputRate + record.outputTokens * binding.outputRate) / 1_000_000;
  if (record.provider !== binding.provider || record.role !== binding.role || record.bindingDigest !== inferenceBindingDigest(binding)
    || record.requestedModel !== binding.model || typeof record.returnedModel !== 'string' || !record.returnedModel || record.returnedModel.length > 200
    || record.promptVersion !== binding.promptVersion || record.schemaVersion !== binding.schemaVersion || record.contextVersion !== binding.contextVersion
    || !Number.isSafeInteger(record.inputTokens) || record.inputTokens < 0 || record.validated && record.inputTokens > binding.maxInputBytes + binding.instructionAllowanceBytes
    || !Number.isSafeInteger(record.outputTokens) || record.outputTokens < 0 || record.validated && record.outputTokens > binding.maxOutputTokens
    || typeof record.validated !== 'boolean' || !Number.isFinite(Date.parse(record.startedAt)) || !Number.isFinite(Date.parse(record.completedAt)) || Date.parse(record.completedAt) < Date.parse(record.startedAt)
    || !Number.isFinite(record.usd) || Math.abs(record.usd - usd) > 1e-9 || actualUsd === undefined || !Number.isFinite(actualUsd) || Math.abs(actualUsd - usd) > 1e-9) {
    throw new DomainError('invalid', 'Inference provenance does not match the admitted policy.');
  }
}
/** Uses stored admission, never the worker's mutable claim copy or current env. */
export function validateInferenceCompletion(job: PracticeJob, result: JobResult, scenario: Scenario, session: Session) {
  if (job.kind === 'run' || result.kind === 'run') return;
  if (digest(job.input) !== job.fingerprint) throw new DomainError('invalid', 'Inference admission identity changed.');
  const binding = compatibleInferenceBinding(job.input.inferenceBinding, job.kind);
  const authored = result.kind === 'interviewer' && result.model === 'authored' || result.kind === 'coach' && result.model === 'authored-observation-only';
  if (authored) {
    const expected = result.kind === 'interviewer' ? authoredQuestion(scenario, session) : observationOnlyReport(scenario);
    if (digest(result.kind === 'interviewer' ? result.proposal : result.kind === 'coach' ? result.report : null) !== digest(expected)) throw new DomainError('invalid', 'Authored fallback must match the deterministic authored output.');
    if (result.kind === 'coach' && result.promptVersion !== PROMPT_VERSION) throw new DomainError('invalid', 'Authored fallback provenance is invalid.');
    if (!result.inference && (result.actualUsd === 0 || result.actualUsd === undefined && binding && !job.input.forceAuthored && job.reservedUsd > 0)) return;
  }
  if (!binding || job.input.forceAuthored || job.reservedUsd + 1e-9 < binding.reserveUsd || !result.inference) throw new DomainError('invalid', 'Provider output requires its admitted inference policy and recorded usage.');
  validateInferenceRecord(result.inference, binding, result.actualUsd);
  if (authored ? result.inference.validated : !result.inference.validated || result.model !== result.inference.returnedModel) throw new DomainError('invalid', 'Inference result identity or validation status is invalid.');
  if (result.kind === 'coach' && result.promptVersion !== (authored ? PROMPT_VERSION : binding.promptVersion)) throw new DomainError('invalid', 'Coaching prompt identity does not match admission.');
}
