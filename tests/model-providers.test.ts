import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredInferenceBinding, parseInferenceBinding } from '../lib/ai/binding';
import { assist, observationOnlyReport, ProviderFailure } from '../lib/ai/provider';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import type { JobKind, Session } from '../lib/interview-practice/types';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { processOneJob } from '../lib/server/worker';

// Synthetic HTTP only. These tests establish application policy/transport
// mechanics, never provider access, current tariffs, quality or invoice cost.
const scenario = getScenario('monetary-validation')!;
const owner = 'synthetic-provider-owner';
const key = () => randomUUID();
const fetchMock = vi.fn<typeof fetch>();
const ordinaryUsage = { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard', inference_geo: 'global' };
const knownCost = (100 * 3 + 40 * 15) / 1_000_000;
function anthropic(value: unknown, changes: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ id: 'msg_synthetic_provider', type: 'message', role: 'assistant', model: 'synthetic-anthropic-returned-snapshot', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }], usage: ordinaryUsage, ...changes }), { headers: { 'request-id': 'synthetic-anthropic-request' } });
}
function openai(value: unknown) {
  return new Response(JSON.stringify({ id: 'resp_synthetic_provider', status: 'completed', model: 'synthetic-openai-returned-snapshot', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }], usage: { input_tokens: 100, output_tokens: 40 } }));
}
function output(kind: Exclude<JobKind, 'run'>) {
  const probe = scenario.probes.find(row => row.stageId === 'debrief')!;
  return kind === 'assistant' ? { message: 'Trace the input contract before changing arithmetic.', files: [] }
    : kind === 'coach' ? observationOnlyReport(scenario)
    : { action: 'ask_probe', question: 'Which boundary case would you check next?', competencyId: probe.competencyId, probeId: probe.id, evidenceIds: [] };
}
async function admitted(kind: Exclude<JobKind, 'run'>, mode: 'ask' | 'plan' | 'edit' = 'ask') {
  const store = new MemoryPracticeStore();
  const service = new SessionService(store, getScenario, { maxSessionUsd: 10 });
  let session = (await service.createSession(owner, { scenarioId: scenario.id, requestId: key() })).session;
  if (kind === 'assistant') await service.requestAssistant(owner, session.id, { requestId: key(), expectedRevision: session.revision, mode, message: 'Inspect this implementation.' });
  else {
    const finished = await service.command(owner, session.id, { requestId: key(), expectedRevision: session.revision, action: 'finish' });
    if (kind === 'coach') {
      await service.cancelJob(owner, finished.job!.id, { requestId: key() });
      session = await service.getSession(owner, session.id);
      await service.command(owner, session.id, { requestId: key(), expectedRevision: session.revision, action: 'submit' });
    }
  }
  const before = await service.exportSession(owner, session.id), job = before.jobs.at(-1)!;
  return { service, store, id: session.id, before, job };
}

beforeEach(() => {
  vi.stubEnv('AI_PROVIDER', 'anthropic-messages');
  vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); vi.stubEnv('FEATURE_REPORT_GENERATION', 'true'); vi.stubEnv('FEATURE_ANTHROPIC_INFERENCE', 'true');
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-anthropic-key-never-sent'); vi.stubEnv('ANTHROPIC_MODEL', 'synthetic-anthropic-model');
  vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', '3'); vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', '15');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-openai-key-never-sent'); vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini');
  vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400');
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('configured provider through actual role and worker boundaries', () => {
  it('preserves the default OpenAI Responses path when no provider is selected', async () => {
    vi.stubEnv('AI_PROVIDER', undefined);
    const context = await admitted('assistant'); fetchMock.mockImplementation(async () => openai(output('assistant')));
    await processOneJob(context.service);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]!.body));
    expect(body).toMatchObject({ model: 'gpt-5.4-mini', store: false, max_output_tokens: 2400 });
    expect(body.text.format.strict).toBe(true); expect(body.tools).toBeUndefined();
    const saved = await context.service.exportSession(owner, context.id);
    expect(saved.jobs.at(-1)).toMatchObject({ state: 'completed', inference: { provider: 'openai-responses', returnedModel: 'synthetic-openai-returned-snapshot' } });
  });

  it.each(['interviewer', 'assistant', 'coach'] as const)('executes the admitted Anthropic %s policy after ambient provider/model/rate drift', async kind => {
    const context = await admitted(kind), binding = parseInferenceBinding(context.job.input.inferenceBinding)!;
    expect(binding).toMatchObject({ provider: 'anthropic-messages', model: 'synthetic-anthropic-model', inputRate: 3, outputRate: 15 });
    vi.stubEnv('AI_PROVIDER', 'openai-responses'); vi.stubEnv('ANTHROPIC_MODEL', 'replacement-model');
    vi.stubEnv('ANTHROPIC_INPUT_USD_PER_MILLION', 'invalid'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', 'invalid');
    fetchMock.mockImplementation(async () => anthropic(output(kind)));
    await processOneJob(context.service);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0], body = JSON.parse(String(options!.body));
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options!.headers).toMatchObject({ 'x-api-key': 'synthetic-anthropic-key-never-sent', 'anthropic-version': '2023-06-01' });
    expect(body).toMatchObject({ model: binding.model, max_tokens: binding.maxOutputTokens, service_tier: 'standard_only', messages: [{ role: 'user' }] });
    expect(body.system).toContain('untrusted quoted data');
    expect(body.output_config.format.type).toBe('json_schema'); expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('store'); expect(body).not.toHaveProperty('input');
    const saved = await context.service.exportSession(owner, context.id), job = saved.jobs.at(-1)!;
    expect(job.input).toEqual(context.job.input); expect(job.fingerprint).toBe(digest(job.input));
    expect(job).toMatchObject({ state: 'completed', actualUsd: knownCost, inference: { provider: 'anthropic-messages', role: kind, requestedModel: binding.model, returnedModel: 'synthetic-anthropic-returned-snapshot', inputTokens: 100, outputTokens: 40, usd: knownCost, validated: true, providerRequestId: 'synthetic-anthropic-request', responseId: 'msg_synthetic_provider' } });
    expect(JSON.stringify(await context.service.getSession(owner, context.id))).not.toContain('synthetic-anthropic-request');
    if (kind === 'assistant') {
      const input = JSON.stringify(body.messages);
      expect(input).not.toContain(scenario.tests.find(test => !test.visible)!.source);
      expect(input).not.toContain(Object.values(scenario.referenceFiles).join(''));
    }
  });

  it('keeps the report generation, provider and tariff across an explicit retry', async () => {
    const context = await admitted('coach'), claim = (await context.service.claimJob('synthetic-failed-worker'))!;
    await context.service.failJob(claim, 'Synthetic pre-call interruption.', 0);
    vi.stubEnv('AI_PROVIDER', 'openai-responses'); vi.stubEnv('ANTHROPIC_MODEL', 'new-ambient-model'); vi.stubEnv('ANTHROPIC_OUTPUT_USD_PER_MILLION', '99');
    await context.service.retryReport(owner, context.id, { requestId: key() });
    fetchMock.mockImplementation(async () => anthropic(output('coach'))); await processOneJob(context.service);
    const saved = await context.service.exportSession(owner, context.id), job = saved.jobs.at(-1)!;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(job.id).toBe(context.job.id); expect(job.input).toEqual(context.job.input); expect(job.reservationSequence).toBe(2);
    expect(saved.reports[0].generationId).toBe(context.job.input.generationId); expect(job.actualUsd).toBe(knownCost);
  });

  for (const kind of ['interviewer', 'assistant', 'coach'] as const) {
    it.each(['key', 'provider-flag', 'global-kill'] as const)(`does not call or switch a bound ${kind} after its %s closes`, async gate => {
      const context = await admitted(kind); vi.stubEnv('AI_PROVIDER', 'openai-responses');
      vi.stubEnv(gate === 'key' ? 'ANTHROPIC_API_KEY' : gate === 'provider-flag' ? 'FEATURE_ANTHROPIC_INFERENCE' : 'FEATURE_AI_INTERVIEW', gate === 'key' ? '' : 'false');
      await processOneJob(context.service);
      expect(fetchMock).not.toHaveBeenCalled();
      const saved = await context.service.exportSession(owner, context.id), job = saved.jobs.at(-1)!;
      expect(job.state).toBe(kind === 'assistant' ? 'failed' : 'completed'); expect(job.actualUsd).toBe(0);
      expect(saved.usage.spentUsd).toBe(0); expect(saved.usage.uncertainUsd).toBe(0);
      expect(job.input).toEqual(context.job.input);
      if (kind === 'coach') expect(saved.reports[0].model).toBe('authored-observation-only');
      if (kind === 'interviewer') expect(saved.turns.at(-1)?.source).toBe('authored');
    });
  }
  it('honors the independent report kill switch for an admitted Anthropic coach', async () => {
    const context = await admitted('coach'); vi.stubEnv('FEATURE_REPORT_GENERATION', 'false');
    await processOneJob(context.service);
    expect(fetchMock).not.toHaveBeenCalled();
    const saved = await context.service.exportSession(owner, context.id);
    expect(saved.reports[0].rubric.every(row => row.level === 'Not observed')).toBe(true); expect(saved.jobs.at(-1)?.actualUsd).toBe(0);
  });

  it('records an edit proposal without applying it, then requires the explicit learner decision', async () => {
    const context = await admitted('assistant', 'edit'), proposed = context.before.files['quote.py'] + '\n# Synthetic proposed edit\n';
    fetchMock.mockImplementation(async () => anthropic({ message: 'Preview this bounded proposal.', files: [{ path: 'quote.py', content: proposed }] }));
    await processOneJob(context.service);
    const saved = await context.service.getSession(owner, context.id), proposal = saved.editProposals[0];
    expect(saved.files).toEqual(context.before.files); expect(proposal).toMatchObject({ status: 'pending', files: { 'quote.py': proposed } });
    await context.service.decideEdit(owner, context.id, { requestId: key(), expectedRevision: saved.revision, proposalId: proposal.id, decision: 'accept' });
    expect((await context.service.getSession(owner, context.id)).files['quote.py']).toBe(proposed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Anthropic rejected output and accounting', () => {
  it.each([
    ['invalid-json', { content: [{ type: 'text', text: '{invalid' }] }],
    ['max-tokens', { stop_reason: 'max_tokens' }],
    ['refusal', { stop_reason: 'refusal' }],
    ['refusal-details', { stop_details: { type: 'refusal' } }],
    ['tool-use', { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'synthetic-tool', name: 'execute', input: { command: 'NEVER-EXECUTE' } }] }],
  ])('settles known ordinary usage for %s without accepting output, replaying or switching', async (_name, changes) => {
    const context = await admitted('assistant'); fetchMock.mockImplementation(async () => anthropic(output('assistant'), changes as Record<string, unknown>));
    await processOneJob(context.service);
    const saved = await context.service.exportSession(owner, context.id), job = saved.jobs.at(-1)!;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
    expect(job).toMatchObject({ state: 'failed', actualUsd: knownCost, inference: { provider: 'anthropic-messages', validated: false, usd: knownCost } });
    expect(saved.usage.spentUsd).toBeCloseTo(knownCost); expect(saved.usage.uncertainUsd).toBe(0);
    expect(saved.files).toEqual(context.before.files); expect(saved.editProposals).toEqual([]); expect(saved.assistantMessages.filter(message => message.role === 'assistant')).toEqual([]);
  });

  it.each([
    ['missing-usage', undefined],
    ['malformed-token-count', { ...ordinaryUsage, output_tokens: '40' }],
    ['positive-cache-read', { ...ordinaryUsage, cache_read_input_tokens: 1 }],
    ['positive-cache-write', { ...ordinaryUsage, cache_creation_input_tokens: 1 }],
    ['nested-cache-write', { ...ordinaryUsage, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 0 } }],
    ['server-tool-meter', { ...ordinaryUsage, server_tool_use: { web_search_requests: 1 } }],
    ['nonstandard-tier', { ...ordinaryUsage, service_tier: 'priority' }],
    ['nonstandard-region', { ...ordinaryUsage, inference_geo: 'us' }],
  ])('retains uncertain reservation for %s instead of inventing ordinary token cost', async (_name, usage) => {
    const context = await admitted('assistant'); fetchMock.mockImplementation(async () => anthropic(output('assistant'), { usage }));
    await processOneJob(context.service);
    const saved = await context.service.exportSession(owner, context.id), job = saved.jobs.at(-1)!;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(job.state).toBe('failed'); expect(job.actualUsd).toBeUndefined(); expect(job.inference).toBeUndefined();
    expect(saved.usage.spentUsd).toBe(0); expect(saved.usage.uncertainUsd).toBeCloseTo(context.job.reservedUsd);
    expect(saved.files).toEqual(context.before.files); expect(saved.editProposals).toEqual([]);
  });

  it.each(['ask', 'plan'] as const)('rejects %s-mode file changes locally and retains known usage', async mode => {
    const context = await admitted('assistant', mode);
    fetchMock.mockImplementation(async () => anthropic({ message: 'Unpermitted change.', files: [{ path: 'quote.py', content: '# Must not apply' }] }));
    await processOneJob(context.service);
    const saved = await context.service.exportSession(owner, context.id);
    expect(saved.jobs.at(-1)).toMatchObject({ state: 'failed', actualUsd: knownCost, inference: { validated: false } });
    expect(saved.files).toEqual(context.before.files); expect(saved.editProposals).toEqual([]); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown coach evidence locally while retaining known usage and frozen evidence', async () => {
    const context = await admitted('coach'), report = observationOnlyReport(scenario);
    report.rubric[0] = { ...report.rubric[0], level: 'Strong', evidenceIds: ['invented-evidence'] };
    fetchMock.mockImplementation(async () => anthropic(report)); await processOneJob(context.service);
    const saved = await context.service.exportSession(owner, context.id);
    expect(saved.frozenEvidence).toEqual(context.before.frozenEvidence);
    expect(saved.reports[0].model).toBe('authored-observation-only'); expect(saved.reports[0].rubric.every(row => row.level === 'Not observed')).toBe(true);
    expect(saved.jobs.at(-1)).toMatchObject({ actualUsd: knownCost, inference: { validated: false } }); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('provider cancellation boundary', () => {
  async function directSession(): Promise<Session> {
    const context = await admitted('assistant'); return context.before;
  }
  it('rejects an already-aborted request before fetch with definite zero-call accounting', async () => {
    const session = await directSession(), controller = new AbortController(); controller.abort();
    await expect(assist(scenario, session, { mode: 'ask', prompt: 'Inspect.' }, controller.signal, configuredInferenceBinding('assistant'))).rejects.toMatchObject({ mayHaveBilled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('preserves uncertain billing when cancellation happens after fetch starts', async () => {
    const session = await directSession(), controller = new AbortController();
    let notifyStarted!: () => void; const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    fetchMock.mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      notifyStarted(); options!.signal!.addEventListener('abort', () => reject(new DOMException('Synthetic cancellation', 'AbortError')), { once: true });
    }));
    const pending = assist(scenario, session, { mode: 'ask', prompt: 'Inspect.' }, controller.signal, configuredInferenceBinding('assistant'));
    const rejection = expect(pending).rejects.toMatchObject({ mayHaveBilled: true });
    await started; controller.abort(); await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });
  it('does not silently use the other configured provider after a transport failure', async () => {
    const session = await directSession(); fetchMock.mockRejectedValue(new Error('Synthetic interrupted HTTP transport'));
    await expect(assist(scenario, session, { mode: 'ask', prompt: 'Inspect.' }, undefined, configuredInferenceBinding('assistant'))).rejects.toBeInstanceOf(ProviderFailure);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });
});
