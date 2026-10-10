import { z } from 'zod';
import { inferenceBindingFromPolicy, parseInferenceBinding, validateInferenceRecord, type InferenceBinding } from '../lib/ai/binding';
import type { AiRole, modelPolicy } from '../lib/ai/policy';
import type { InferenceRecord } from '../lib/interview-practice/types';

/** Optional only for historical recordings. Newly recorded runs always carry it. */
export const recordedBindingsSchema = z.array(z.custom<InferenceBinding>(value => parseInferenceBinding(value) !== null).transform(value => parseInferenceBinding(value)!)).min(1).max(3);
type Policy = ReturnType<typeof modelPolicy>;
type Planned = { role: string; reservedUsd: number };
export const evaluationProviderRole = (role: string): AiRole => role.startsWith('assistant-') ? 'assistant' : role as 'interviewer' | 'coach';

export function captureEvaluationBindings(policy: Policy, roles: readonly string[]) {
  return [...new Set(roles.map(evaluationProviderRole))].map(role => Object.freeze(inferenceBindingFromPolicy(role, policy)));
}

/** Offline reconstruction uses the recorded policy, never current deployment settings. */
export function validateEvaluationBindings(bindings: InferenceBinding[] | undefined, policy: Policy, promptVersion: string, planned: readonly Planned[]) {
  if (bindings === undefined) return null;
  const parsed = recordedBindingsSchema.parse(bindings), expected = new Set(planned.map(row => evaluationProviderRole(row.role)));
  const byRole = new Map(parsed.map(binding => [binding.role, binding]));
  if (byRole.size !== parsed.length || byRole.size !== expected.size || [...expected].some(role => !byRole.has(role))) throw new Error('Recorded inference bindings do not cover the planned roles exactly.');
  for (const binding of parsed) {
    if (binding.model !== policy.model || binding.inputRate !== policy.inputRate || binding.outputRate !== policy.outputRate || binding.maxOutputTokens !== policy.maxOutput || binding.promptVersion !== promptVersion) throw new Error('Recorded inference binding differs from its admitted policy.');
  }
  if (planned.some(row => row.reservedUsd !== byRole.get(evaluationProviderRole(row.role))!.reserveUsd)) throw new Error('Recorded reservation differs from its inference binding.');
  return byRole;
}

export function validateBoundEvaluationInference(record: InferenceRecord, binding: InferenceBinding, actualUsd: number | undefined) {
  validateInferenceRecord(record, binding, actualUsd);
}

export function hasBoundInferenceFields(record: InferenceRecord) {
  return ['provider', 'role', 'schemaVersion', 'contextVersion', 'bindingDigest'].some(field => Object.hasOwn(record, field));
}
