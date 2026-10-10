// Hypothetical attempts and intercepted HTTP only; no live model or human review.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadRecipes, loadRuntimeCapture, materializeAttempt, conservativeReport, type BenchmarkAttempt } from '../evals/benchmark';
import { compareRoleRuns, createRolePlan, recordRoleRun, validateRoleRun, type RoleRun } from '../evals/role-runner';
import { createPrivateRolePlan, recordPrivateRoleRun, validatePrivateRoleRun } from '../evals/private-role-runner';
import { authoredQuestion } from '../lib/ai/provider';
import { inferenceBindingDigest } from '../lib/ai/binding';
import { unitPrivateCorpus, unitPrivateExecutor, unitPrivateOptions } from './private-role-fixtures';

let version: string, attempt: BenchmarkAttempt;
beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER', 'anthropic-messages');
  vi.stubEnv('ANTHROPIC_MODEL', 'unit-claude-plan');
  vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', '2');
  vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', '8');
  vi.stubEnv('ANTHROPIC_API_KEY', 'unit-placeholder-never-sent');
  vi.stubEnv('FEATURE_ANTHROPIC_INFERENCE', 'true');
  vi.stubEnv('FEATURE_AI_INTERVIEW', 'true');
  vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
  vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked provider calls are forbidden.'); }));
  const recipes = await loadRecipes(); version = recipes.version;
  attempt = materializeAttempt(recipes.cases.find(row => row.id === 'money-starter')!, await loadRuntimeCapture());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

type AnthropicRequest = { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }>; output_config: { format: { type: string; schema: { properties: Record<string, unknown> } } } };
type Call = { url: string; body: AnthropicRequest; headers: Headers };
function interceptedMessages(value: (index: number) => unknown | Promise<unknown>, usageExtra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    const output = await value(calls.length - 1);
    return new Response(JSON.stringify({ type: 'message', role: 'assistant', id: `unit-message-${calls.length}`, model: 'unit-resolved-claude', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 200, ...usageExtra }, content: [{ type: 'text', text: JSON.stringify(output) }] }), { headers: { 'request-id': `unit-request-${calls.length}` } });
  }));
  return calls;
}
function driftAmbientProvider() {
  vi.stubEnv('AI_PROVIDER', 'openai-responses');
  vi.stubEnv('OPENAI_MODEL', 'wrong-current-model');
  vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid');
  vi.stubEnv('ANTHROPIC_MODEL', 'different-current-claude');
  vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', 'invalid');
  vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '600');
}
function checkCalls(calls: Call[]) {
  expect(calls).toHaveLength(5);
  for (const call of calls) {
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.body).toMatchObject({ model: 'unit-claude-plan', max_tokens: 2400, output_config: { format: { type: 'json_schema' } } });
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(call.headers.get('authorization')).toBeNull();
    expect(call.body.messages[0].role).toBe('user');
    expect(call.body.system).toContain('untrusted quoted data');
    expect(JSON.stringify(call.body)).not.toContain(attempt.scenario.tests.find(test => !test.visible)!.source);
    expect(call.body).not.toHaveProperty('tools');
  }
  expect(calls.slice(2).map(call => JSON.parse(call.body.messages[0].content).mode)).toEqual(['ask', 'plan', 'edit']);
}
function checkRecorded(run: Pick<RoleRun, 'policy' | 'inferenceBindings' | 'entries'>) {
  expect(run.policy.provider).toBe('anthropic-messages');
  expect(run.inferenceBindings).toHaveLength(3);
  expect(run.inferenceBindings!.every(binding => binding.provider === 'anthropic-messages' && binding.model === 'unit-claude-plan' && binding.inputRate === 2 && binding.outputRate === 8)).toBe(true);
  expect(run.entries.every(entry => entry.state === 'validated' && entry.knownUsd === 0.0036 && entry.inference?.provider === 'anthropic-messages' && entry.inference.requestedModel === 'unit-claude-plan' && entry.inference.returnedModel === 'unit-resolved-claude' && entry.inference.providerRequestId?.startsWith('unit-request-'))).toBe(true);
}

describe('configured provider in controlled evaluation recording', () => {
  it('creates provider-bound zero-call plans in both corpus paths without selecting prices implicitly', () => {
    for (const plan of [createRolePlan(version, [attempt]), createPrivateRolePlan({ corpus: unitPrivateCorpus() })]) {
      expect(plan.policy.provider).toBe('anthropic-messages');
      expect(plan.inferenceBindings.every(binding => binding.provider === plan.policy.provider)).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
    vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', '');
    expect(() => createRolePlan(version, [attempt])).toThrow('explicitly');
    expect(() => createPrivateRolePlan({ corpus: unitPrivateCorpus() })).toThrow('explicitly');
  });
  it('uses the actual production Messages adapter for all development roles and keeps the admitted provider after drift', async () => {
    const plan = createRolePlan(version, [attempt]), journals: RoleRun[] = [];
    const calls = interceptedMessages(index => {
      const task = plan.tasks[index];
      return task.role === 'coach' ? conservativeReport(task.attempt) : task.role === 'interviewer' ? authoredQuestion(task.attempt.scenario, task.session) : { message: 'Hypothetical intercepted assistant response.', files: [] };
    });
    const run = await recordRoleRun(version, [attempt], { acknowledgePaidApi: true, maxUsd: 5, persist: async row => { journals.push(row); driftAmbientProvider(); } });
    checkCalls(calls); checkRecorded(run);
    expect(run.inferenceBindings).toEqual(journals[0].inferenceBindings);
    expect(validateRoleRun(run)).toEqual(run);
  });
  it('uses the same captured production provider for private cases without changing corpus or context identities', async () => {
    const context = { corpus: unitPrivateCorpus() }, original = structuredClone(context), plan = createPrivateRolePlan(context);
    const calls = interceptedMessages(async index => {
      const result = await unitPrivateExecutor(plan.tasks[index]);
      return result.kind === 'coach' ? result.report : result.kind === 'interviewer' ? result.proposal : { message: 'Hypothetical private intercepted assistant response.', files: [] };
    });
    const run = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), maxUsd: 5, executor: undefined, persist: async () => { driftAmbientProvider(); } });
    checkCalls(calls); checkRecorded(run);
    expect(validatePrivateRoleRun(run, context).run).toEqual(run); expect(context).toEqual(original);
    expect(run.planned).toEqual(plan.planned);
  });
  it('keeps recording acknowledgement, provider availability and full-plan cap checks before a journal or request', async () => {
    const persist = vi.fn(), base = { acknowledgePaidApi: true, maxUsd: 5, persist };
    await expect(recordRoleRun(version, [attempt], { ...base, acknowledgePaidApi: false })).rejects.toThrow('acknowledgement');
    await expect(recordRoleRun(version, [attempt], { ...base, maxUsd: 0.000001 })).rejects.toThrow('cap');
    vi.stubEnv('FEATURE_ANTHROPIC_INFERENCE', 'false');
    await expect(recordRoleRun(version, [attempt], base)).rejects.toThrow('configured');
    await expect(recordPrivateRoleRun({ corpus: unitPrivateCorpus() }, { ...unitPrivateOptions(), executor: undefined, persist })).rejects.toThrow('unavailable');
    expect(persist).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('stops on nonstandard Anthropic usage with uncertain reservation and no automatic OpenAI fallback', async () => {
    const calls = interceptedMessages(() => authoredQuestion(attempt.scenario, attempt.session), { cache_creation_input_tokens: 100 });
    const run = await recordRoleRun(version, [attempt], { acknowledgePaidApi: true, maxUsd: 5, persist: async () => {} });
    expect(calls).toHaveLength(1);
    expect(run).toMatchObject({ state: 'stopped', stopReason: 'uncertain-charge', policy: { provider: 'anthropic-messages' } });
    expect(run.entries[0]).toMatchObject({ state: 'uncertain', inference: null, output: null, knownUsd: 0, uncertainUsd: run.planned[0].reservedUsd });
    expect(validateRoleRun(run)).toEqual(run);
  });
  it('rejects changed or removed provider provenance during offline review instead of consulting ambient configuration', async () => {
    interceptedMessages(() => ({ message: 'Hypothetical provider-bound assistant.', files: [] }));
    const run = await recordRoleRun(version, [attempt], { acknowledgePaidApi: true, maxUsd: 5, roles: ['assistant-ask'], persist: async () => {} });
    for (const mutate of [
      (copy: RoleRun) => { copy.policy.provider = 'openai-responses'; },
      (copy: RoleRun) => { delete copy.policy.provider; },
      (copy: RoleRun) => { copy.entries[0].inference!.provider = 'openai-responses'; },
      (copy: RoleRun) => { delete copy.inferenceBindings; },
    ]) { const copy = structuredClone(run); mutate(copy); expect(() => validateRoleRun(copy)).toThrow(); }
    const copy = structuredClone(run); (copy.policy as { provider: string }).provider = 'unknown-vendor';
    expect(() => validateRoleRun(copy)).toThrow();
    vi.stubEnv('AI_PROVIDER', 'invalid-current-provider');
    expect(validateRoleRun(run)).toEqual(run);
  });
  it('keeps historical OpenAI recordings without provider or binding fields readable offline', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai-responses'); vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini');
    vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5');
    const context = { corpus: unitPrivateCorpus() }, run = await recordPrivateRoleRun(context, unitPrivateOptions());
    delete run.policy.provider; delete run.inferenceBindings;
    for (const entry of run.entries) for (const field of ['provider', 'role', 'schemaVersion', 'contextVersion', 'bindingDigest'] as const) delete entry.inference?.[field];
    vi.stubEnv('AI_PROVIDER', 'invalid-current-provider'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid');
    expect(validatePrivateRoleRun(run, context).run).toEqual(run); expect(fetch).not.toHaveBeenCalled();
  });
  it('identifies providers separately when comparison candidates use the same model string, including historical OpenAI rows', async () => {
    interceptedMessages(() => ({ message: 'Hypothetical candidate.', files: [] }));
    const base = { acknowledgePaidApi: true, maxUsd: 5, roles: ['assistant-ask'] as const, persist: async () => {} };
    const anthropic = await recordRoleRun(version, [attempt], { ...base, roles: [...base.roles] });
    vi.stubEnv('AI_PROVIDER', 'openai-responses'); vi.stubEnv('OPENAI_MODEL', 'unit-claude-plan');
    vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '2'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '8');
    const openai = await recordRoleRun(version, [attempt], { ...base, roles: [...base.roles], executor: async task => ({ kind: 'assistant', message: 'Hypothetical candidate.', files: {}, model: 'unit-resolved-claude', actualUsd: 0.0036, inference: { ...anthropic.entries[0].inference!, provider: task.inferenceBinding.provider, bindingDigest: inferenceBindingDigest(task.inferenceBinding) } }) });
    delete openai.policy.provider;
    const comparison = compareRoleRuns([anthropic, openai]);
    expect(comparison.rows.map(row => [row.provider, row.requestedModel])).toEqual([['anthropic-messages', 'unit-claude-plan'], ['openai-responses', 'unit-claude-plan']]);
    expect(comparison.quality).toBe('pending-independent-human-review');
  });
});
