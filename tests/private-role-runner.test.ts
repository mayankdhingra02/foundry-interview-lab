import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../lib/interview-practice/domain';
import { ProviderFailure } from '../lib/ai/provider';
import { createPrivateRoleContexts, createPrivateRolePlan, recordPrivateRoleRun, validatePrivateRoleRun, type PrivateRoleRun } from '../evals/private-role-runner';
import { unitPrivateCorpus, unitPrivateExecutor, unitPrivateOptions, unitRecordedAt } from './private-role-fixtures';

beforeEach(() => { vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400'); vi.stubEnv('OPENAI_API_KEY', ''); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External calls forbidden.'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('separate private role recording and exact offline binding', () => {
  it('plans five independent roles without manufacturing execution/model or development provenance', () => {
    const context = { corpus: unitPrivateCorpus() }, plan = createPrivateRolePlan(context);
    expect(plan.planned.map(row => row.role)).toEqual(['interviewer', 'coach', 'assistant-ask', 'assistant-plan', 'assistant-edit']);
    expect(new Set(plan.planned.map(row => row.contextDigest)).size).toBe(5); expect(plan.planned.every(row => row.runtimeDigests.length === 0)).toBe(true);
    expect(plan.corpus.corpus.split).toBe('acceptance'); expect(fetch).not.toHaveBeenCalled();
  });
  it('reconstructs contexts offline without current provider pricing', async () => {
    const context = { corpus: unitPrivateCorpus() }, run = await recordPrivateRoleRun(context, unitPrivateOptions()), before = createPrivateRoleContexts(context);
    vi.stubEnv('OPENAI_MODEL', 'invalid-current-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', 'invalid');
    expect(() => createPrivateRolePlan(context)).toThrow(); expect(createPrivateRoleContexts(context)).toEqual(before);
    expect(validatePrivateRoleRun(run, context).run).toEqual(run); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires both paid gates, a complete bounded reservation and configured roles before any write/call', async () => {
    const context = { corpus: unitPrivateCorpus() }, executor = vi.fn(unitPrivateExecutor), persist = vi.fn(), options = { ...unitPrivateOptions(), executor, persist };
    for (const change of [{ enabled: false }, { acknowledgePaidApi: false }, { maxUsd: 0 }, { maxUsd: 0.000001 }, { maxUsd: 1001 }, { maxUsd: NaN }, { operatorId: 'bad/operator' }]) await expect(recordPrivateRoleRun(context, { ...options, ...change })).rejects.toThrow();
    await expect(recordPrivateRoleRun(context, { ...options, executor: undefined })).rejects.toThrow('unavailable');
    expect(persist).not.toHaveBeenCalled(); expect(executor).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('journals reservations before each call without modifying inputs and preserves role/context identities', async () => {
    const context = { corpus: unitPrivateCorpus() }, original = structuredClone(context), journals: PrivateRoleRun[] = [];
    const run = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), persist: async row => { journals.push(row); }, executor: async task => { expect(journals.at(-1)!.entries.at(-1)).toMatchObject({ state: 'reserved', contextDigest: task.contextDigest, uncertainUsd: task.reservedUsd }); return unitPrivateExecutor(task); } });
    expect(run).toMatchObject({ artifact: 'private-corpus-model-run', corpus: { split: 'acceptance' }, state: 'completed', holdoutUnlockDigest: null });
    expect(run.entries.every(entry => entry.state === 'validated')).toBe(true); expect(context).toEqual(original); expect(validatePrivateRoleRun(run, context).run).toEqual(run);
  });
  it('requires a separate exact custodian unlock for holdout recording and later import', async () => {
    const corpus = unitPrivateCorpus('holdout'), executor = vi.fn(unitPrivateExecutor), persist = vi.fn(), options = { ...unitPrivateOptions(), executor, persist };
    const unlock = { version: 1, purpose: 'one-run-heldout-model-evaluation', corpus: corpus.corpus, corpusDigest: digest(corpus), runId: '00000000-0000-4000-8000-000000000061', custodianId: corpus.independence.custodianId, authorizedOperatorId: options.operatorId, acknowledgedAt: unitRecordedAt };
    for (const value of [undefined, { ...unlock, custodianId: 'wrong' }, { ...unlock, corpusDigest: 'a'.repeat(64) }, { ...unlock, acknowledgedAt: '2026-10-10T00:00:00.000Z' }, { ...unlock, authorizedOperatorId: 'someone-else' }]) await expect(recordPrivateRoleRun({ corpus }, { ...options, holdoutUnlock: value })).rejects.toThrow();
    expect(executor).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
    const run = await recordPrivateRoleRun({ corpus }, { ...options, holdoutUnlock: unlock });
    expect(run.holdoutUnlockDigest).toBe(digest(unlock)); expect(() => validatePrivateRoleRun(run, { corpus })).toThrow();
    expect(validatePrivateRoleRun(run, { corpus, holdoutUnlock: unlock }).run).toEqual(run);
    await expect(recordPrivateRoleRun({ corpus: unitPrivateCorpus() }, { ...options, holdoutUnlock: unlock })).rejects.toThrow();
  });
  it('preserves uncertain/cost-bound/no-charge outcomes and never retries them', async () => {
    const context = { corpus: unitPrivateCorpus() };
    const uncertain = vi.fn(async () => { throw new ProviderFailure(true); }), run = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), executor: uncertain });
    expect(run).toMatchObject({ state: 'stopped', stopReason: 'uncertain-charge' }); expect(uncertain).toHaveBeenCalledTimes(1); expect(validatePrivateRoleRun(run, context).run.entries[0].uncertainUsd).toBe(run.planned[0].reservedUsd);
    const cost = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), executor: async task => ({ ...await unitPrivateExecutor(task), inference: { ...(await unitPrivateExecutor(task)).inference!, usd: 1 }, actualUsd: 1 }) });
    expect(cost.stopReason).toBe('cost-bound-exceeded'); expect(cost.entries).toHaveLength(1); expect(validatePrivateRoleRun(cost, context).run.entries[0].output).toBeNull();
    const noCharge = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), roles: ['coach'], executor: async () => { throw new ProviderFailure(false); } });
    expect(noCharge.entries[0]).toMatchObject({ state: 'rejected', knownUsd: 0, uncertainUsd: 0 });
  });
  it('makes no provider call if the reservation journal write fails and retains an uncompleted journal on result-write failure', async () => {
    const context = { corpus: unitPrivateCorpus() }, executor = vi.fn(unitPrivateExecutor); let writes = 0;
    await expect(recordPrivateRoleRun(context, { ...unitPrivateOptions(), executor, persist: async () => { if (++writes === 2) throw new Error('disk'); } })).rejects.toThrow('disk'); expect(executor).not.toHaveBeenCalled();
    writes = 0; const journals: PrivateRoleRun[] = [];
    await expect(recordPrivateRoleRun(context, { ...unitPrivateOptions(), executor, persist: async row => { if (++writes === 3) throw new Error('disk'); journals.push(row); } })).rejects.toThrow('disk');
    expect(executor).toHaveBeenCalledTimes(1); expect(journals.at(-1)!.entries[0].state).toBe('reserved');
  });
  it('stops new work on cancellation and rejects fallback/assistant policy violations without a quality output', async () => {
    const context = { corpus: unitPrivateCorpus() }, controller = new AbortController(); controller.abort(); const execute = vi.fn(unitPrivateExecutor);
    const cancelled = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), executor: execute, signal: controller.signal }); expect(cancelled.stopReason).toBe('operator-cancelled'); expect(execute).not.toHaveBeenCalled();
    for (const role of ['assistant-ask', 'assistant-plan', 'assistant-edit'] as const) {
      const run = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), roles: [role], executor: async task => ({ ...await unitPrivateExecutor(task), kind: 'assistant', model: 'unit-mocked-model', message: 'Hypothetical bad patch', files: { '../host.py': 'x' } }) });
      expect(run.entries[0]).toMatchObject({ state: 'rejected', output: null });
    }
  });
  it('rejects changed private splits/files/conditions, forged accounting, missing entries and mixed legacy artifacts', async () => {
    const context = { corpus: unitPrivateCorpus() }, run = await recordPrivateRoleRun(context, unitPrivateOptions());
    for (const change of [(copy: typeof context) => { copy.corpus.corpus.split = 'holdout'; }, (copy: typeof context) => { copy.corpus.cases[0].dialogue[0].text += ' changed'; }, (copy: typeof context) => { copy.corpus.cases[0].conditions.promptExposure = 'repeated'; }]) { const copy = structuredClone(context); change(copy); expect(() => validatePrivateRoleRun(run, copy)).toThrow(); }
    for (const change of [(copy: PrivateRoleRun) => { copy.entries[0].knownUsd = 0; }, (copy: PrivateRoleRun) => { copy.entries.pop(); }, (copy: PrivateRoleRun) => { copy.planned[0].caseDigest = 'a'.repeat(64); }, (copy: PrivateRoleRun) => { copy.entries.reverse(); }]) { const copy = structuredClone(run); change(copy); expect(() => validatePrivateRoleRun(copy, context)).toThrow(); }
    expect(() => validatePrivateRoleRun({ ...run, corpus: 'development-regression' }, context)).toThrow();
  });
  it('exercises all production role adapters with mocked HTTP while preserving private evidence and protected-source boundaries', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unit-placeholder-never-sent'); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
    const context = { corpus: unitPrivateCorpus() }, plan = createPrivateRolePlan(context), requests: Array<{ input: Array<{ content: string }> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body); const result = await unitPrivateExecutor(plan.tasks[requests.length - 1]);
      const value = result.kind === 'coach' ? result.report : result.kind === 'interviewer' ? result.proposal : { message: 'Mocked HTTP private assistant output only.', files: [] };
      return new Response(JSON.stringify({ id: `unit-http-response-${requests.length}`, status: 'completed', model: 'unit-http-model', usage: { input_tokens: 1000, output_tokens: 200 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }));
    }));
    const run = await recordPrivateRoleRun(context, { ...unitPrivateOptions(), executor: undefined });
    expect(run.entries.every(entry => entry.state === 'validated')).toBe(true); expect(requests).toHaveLength(5); expect(validatePrivateRoleRun(run, context).run).toEqual(run);
    for (const request of requests) expect(request.input[0].content).not.toContain(plan.tasks[0].attempt.scenario.tests.find(test => !test.visible)!.source);
  });
});
