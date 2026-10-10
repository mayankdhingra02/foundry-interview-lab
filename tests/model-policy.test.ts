import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compatibleInferenceBinding, configuredInferenceBinding, inferenceBindingDigest, inferenceBindingFromPolicy, minimumReservation, parseInferenceBinding, validateInferenceRecord } from '../lib/ai/binding';
import { configuredProvider, inferenceReservations, modelPolicy, providerAvailable } from '../lib/ai/policy';
import type { InferenceRecord } from '../lib/interview-practice/types';
import { capabilities } from '../lib/server/config';

const configurationKeys = ['AI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_INPUT_USD_PER_MILLION', 'OPENAI_OUTPUT_USD_PER_MILLION', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_INPUT_USD_PER_MILLION', 'ANTHROPIC_OUTPUT_USD_PER_MILLION', 'FEATURE_ANTHROPIC_INFERENCE', 'AI_MAX_OUTPUT_TOKENS'] as const;
beforeEach(() => {
  for (const name of configurationKeys) vi.stubEnv(name, undefined);
  vi.stubEnv('FEATURE_AI_INTERVIEW', 'true');
  vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider calls are forbidden in configuration tests.'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function anthropicConfiguration() {
  vi.stubEnv('AI_PROVIDER', 'anthropic-messages');
  vi.stubEnv('ANTHROPIC_MODEL', 'synthetic-explicit-model');
  vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', '3');
  vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', '15');
}

describe('explicit model provider policy', () => {
  it('preserves the OpenAI default and legacy policy-derived binding bytes', () => {
    expect(configuredProvider()).toBe('openai-responses');
    expect(modelPolicy()).toEqual({ provider: 'openai-responses', model: 'gpt-5.4-mini', inputRate: .75, outputRate: 4.5, maxOutput: 2400 });
    const legacy = inferenceBindingFromPolicy('assistant', { model: 'gpt-5.4-mini', inputRate: .75, outputRate: 4.5, maxOutput: 2400 });
    expect(configuredInferenceBinding('assistant')).toEqual(legacy);
    expect(inferenceBindingDigest(configuredInferenceBinding('assistant'))).toBe(inferenceBindingDigest(legacy));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'openai', 'anthropic', 'Anthropic-messages', ' anthropic-messages', 'openai-responses '])('rejects ambiguous provider selection %j without fallback', provider => {
    vi.stubEnv('AI_PROVIDER', provider);
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key');
    expect(configuredProvider).toThrow('Invalid AI provider selection.');
    expect(modelPolicy).toThrow();
    expect(capabilities().ai).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires the matching provider key and exact Anthropic enable flag', () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key');
    expect(providerAvailable('openai-responses')).toBe(true);
    expect(providerAvailable('anthropic-messages')).toBe(false);
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-anthropic-key');
    expect(providerAvailable('anthropic-messages')).toBe(false);
    vi.stubEnv('FEATURE_ANTHROPIC_INFERENCE', 'TRUE');
    expect(providerAvailable('anthropic-messages')).toBe(false);
    vi.stubEnv('FEATURE_ANTHROPIC_INFERENCE', 'true');
    expect(providerAvailable('anthropic-messages')).toBe(true);
    vi.stubEnv('ANTHROPIC_API_KEY', ' ');
    expect(providerAvailable('anthropic-messages')).toBe(false);
    expect(providerAvailable('openai-responses')).toBe(true);
  });

  it.each(['ANTHROPIC_MODEL', 'ANTHROPIC_INPUT_USD_PER_MILLION', 'ANTHROPIC_OUTPUT_USD_PER_MILLION'] as const)('never borrows OpenAI configuration when %s is missing', missing => {
    anthropicConfiguration();
    vi.stubEnv('OPENAI_MODEL', 'another-provider-model');
    vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '1');
    vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '2');
    vi.stubEnv(missing, undefined);
    expect(modelPolicy).toThrow('Configure the Anthropic model and both prices explicitly.');
    expect(capabilities().ai).toBe(false);
  });

  it.each(['', ' ', '-1', 'Infinity', 'NaN', '1001'])('rejects missing or invalid explicit Anthropic rate %j', rate => {
    anthropicConfiguration();
    vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', rate);
    expect(modelPolicy).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('captures explicitly supplied Anthropic prices and output limits in the same reservation policy', () => {
    anthropicConfiguration();
    vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '3200');
    const policy = modelPolicy(), binding = configuredInferenceBinding('coach');
    expect(policy).toEqual({ provider: 'anthropic-messages', model: 'synthetic-explicit-model', inputRate: 3, outputRate: 15, maxOutput: 3200 });
    expect(binding).toMatchObject({ version: 1, provider: policy.provider, model: policy.model, inputRate: 3, outputRate: 15, maxOutputTokens: 3200 });
    expect(binding.reserveUsd).toBe(minimumReservation(binding));
    expect(inferenceReservations().coach).toBe(binding.reserveUsd);
    expect(parseInferenceBinding(binding, 'coach')).toEqual(binding);
    expect(compatibleInferenceBinding(binding, 'coach')).toEqual(binding);
    expect(parseInferenceBinding({ ...binding, provider: 'unrecognized-provider' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows explicit zero prices without inventing a paid rate', () => {
    anthropicConfiguration();
    vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', '0');
    vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', '0');
    expect(modelPolicy()).toMatchObject({ inputRate: 0, outputRate: 0 });
    expect(configuredInferenceBinding('assistant').reserveUsd).toBe(0);
  });

  it('retains provider identity through later selection drift and rejects mismatched completion provenance', () => {
    anthropicConfiguration();
    const binding = configuredInferenceBinding('assistant'), bindingDigest = inferenceBindingDigest(binding);
    vi.stubEnv('AI_PROVIDER', 'openai-responses');
    vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', 'invalid');
    expect(compatibleInferenceBinding(binding, 'assistant')).toEqual(binding);
    const usd = (100 * binding.inputRate + 10 * binding.outputRate) / 1_000_000;
    const inference: InferenceRecord = { provider: 'anthropic-messages', role: 'assistant', bindingDigest, requestedModel: binding.model, returnedModel: 'synthetic-returned-snapshot', promptVersion: binding.promptVersion, schemaVersion: binding.schemaVersion, contextVersion: binding.contextVersion, inputTokens: 100, outputTokens: 10, usd, validated: true, startedAt: '2026-10-09T12:00:00Z', completedAt: '2026-10-09T12:00:01Z' };
    expect(() => validateInferenceRecord(inference, binding, usd)).not.toThrow();
    expect(() => validateInferenceRecord({ ...inference, provider: 'openai-responses' }, binding, usd)).toThrow('Inference provenance does not match the admitted policy.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('advertises only the explicitly selected, enabled and fully priced provider', () => {
    anthropicConfiguration();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key');
    expect(capabilities()).toMatchObject({ ai: false, coaching: false });
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-anthropic-key');
    expect(capabilities().ai).toBe(false);
    vi.stubEnv('FEATURE_ANTHROPIC_INFERENCE', 'true');
    expect(capabilities()).toMatchObject({ ai: true, coaching: true });
    vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', undefined);
    expect(capabilities().ai).toBe(false);
    vi.stubEnv('AI_PROVIDER', 'openai-responses');
    expect(capabilities().ai).toBe(true);
    vi.stubEnv('FEATURE_AI_INTERVIEW', 'false');
    expect(capabilities().ai).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
