import { inferenceBindingDigest, parseInferenceBinding } from '../lib/ai/binding';
import type { InferenceRecord, JobClaim, JobResult } from '../lib/interview-practice/types';
import type { SessionService } from '../lib/server/session-service';

/** Explicit synthetic usage for deterministic domain/SQL fixtures. No provider
 * ran. Tests of missing/forged provenance must call completeJob directly. */
export function fixtureInference(claim: JobClaim, usd = 0, times?: { startedAt: string; completedAt: string }): InferenceRecord {
  const binding = parseInferenceBinding(claim.job.input.inferenceBinding);
  if (!binding) throw new Error('Synthetic completion needs an admitted binding.');
  let inputTokens = binding.inputRate ? Math.round(usd * 1_000_000 / binding.inputRate) : 0, outputTokens = 0;
  if (inputTokens > binding.maxInputBytes + binding.instructionAllowanceBytes) {
    inputTokens = binding.maxInputBytes + binding.instructionAllowanceBytes;
    outputTokens = binding.outputRate ? Math.round((usd * 1_000_000 - inputTokens * binding.inputRate) / binding.outputRate) : 0;
  }
  if (outputTokens < 0 || outputTokens > binding.maxOutputTokens) throw new Error('Synthetic usage exceeds its admitted bound; use a deliberately priced fixture binding.');
  return { provider: binding.provider, role: binding.role, bindingDigest: inferenceBindingDigest(binding), requestedModel: binding.model,
    returnedModel: 'synthetic-fixture', promptVersion: binding.promptVersion, schemaVersion: binding.schemaVersion, contextVersion: binding.contextVersion,
    inputTokens, outputTokens, usd: (inputTokens * binding.inputRate + outputTokens * binding.outputRate) / 1_000_000,
    startedAt: times?.startedAt ?? claim.job.updatedAt, completedAt: times?.completedAt ?? claim.job.updatedAt, validated: true };
}
export function completeFixtureJob(service: SessionService, claim: JobClaim, result: JobResult) {
  if (result.kind === 'run' || result.inference || claim.job.input.forceAuthored) return service.completeJob(claim, result);
  const inference = fixtureInference(claim, result.actualUsd ?? 0);
  return service.completeJob(claim, { ...result, model: inference.returnedModel, ...(result.kind === 'coach' ? { promptVersion: inference.promptVersion } : {}), inference, actualUsd: inference.usd });
}
