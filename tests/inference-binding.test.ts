import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredInferenceBinding, inferenceBindingDigest, inferenceBindingFromPolicy, minimumReservation, parseInferenceBinding, PROMPT_VERSION } from '../lib/ai/binding';
import { coach, observationOnlyReport } from '../lib/ai/provider';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import type { InferenceRecord, JobClaim, JobKind, JobResult } from '../lib/interview-practice/types';
import { FilePracticeStore, MemoryPracticeStore, type PracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { processOneJob } from '../lib/server/worker';
import { fixtureInference } from './inference-fixtures';

const scenario = getScenario('monetary-validation')!;
const key = () => randomUUID();
beforeEach(() => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-key-never-sent'); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
  vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const response = (value: unknown, override = {}) => new Response(JSON.stringify({ status: 'completed', model: 'actual-returned-snapshot', usage: { input_tokens: 100, output_tokens: 100 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...override }));
async function admission(kind: Exclude<JobKind, 'run'>, store: PracticeStore = new MemoryPracticeStore(), clock = { now: new Date('2026-10-09T12:00:00Z') }) {
  const service = new SessionService(store, getScenario, { now: () => clock.now, maxSessionUsd: 10, leaseMs: 1000 });
  let session = (await service.createSession('owner', { requestId: key(), scenarioId: scenario.id })).session;
  if (kind === 'assistant') await service.requestAssistant('owner', session.id, { requestId: key(), expectedRevision: session.revision, mode: 'ask', message: 'Inspect this function.' });
  else {
    const question = await service.command('owner', session.id, { requestId: key(), expectedRevision: session.revision, action: 'finish' });
    if (kind === 'coach') {
      await service.cancelJob('owner', question.job!.id, { requestId: key() }); session = await service.getSession('owner', session.id);
      await service.command('owner', session.id, { requestId: key(), expectedRevision: session.revision, action: 'submit' });
    }
  }
  return { service, store, id: session.id, clock };
}
const assistantResult = (claim: JobClaim): Extract<JobResult, { kind: 'assistant' }> => ({ kind: 'assistant', model: 'synthetic-fixture', message: 'Synthetic bounded response.', actualUsd: 0, inference: fixtureInference(claim) });

describe('immutable admitted inference policy', () => {
  it('executes admitted model, output limit and rates despite malformed replacement configuration', async () => {
    const context = await admission('assistant'), before = await context.service.exportSession('owner', context.id), binding = parseInferenceBinding(before.jobs[0].input.inferenceBinding)!;
    expect(before.jobs[0].reservedUsd).toBe(binding.reserveUsd); expect(binding.reserveUsd).toBeGreaterThanOrEqual(minimumReservation(binding));
    vi.stubEnv('OPENAI_MODEL', 'replacement-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', 'invalid');
    const fetch = vi.fn().mockImplementation(() => response({ message: 'Inspect the input contract.', files: [] })); vi.stubGlobal('fetch', fetch);
    await processOneJob(context.service);
    const sent = JSON.parse(fetch.mock.calls[0][1].body), saved = await context.service.exportSession('owner', context.id);
    expect(sent.model).toBe(binding.model); expect(sent.max_output_tokens).toBe(binding.maxOutputTokens);
    expect(saved.jobs[0].input).toEqual(before.jobs[0].input); expect(saved.jobs[0].state).toBe('completed');
    expect(saved.jobs[0].inference).toMatchObject({ requestedModel: binding.model, returnedModel: 'actual-returned-snapshot', provider: binding.provider, schemaVersion: binding.schemaVersion, contextVersion: binding.contextVersion, bindingDigest: inferenceBindingDigest(binding), usd: .000525 });
  });
  it('never lets a configured reservation floor lower the captured policy bound', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario, { reservations: { assistant: .001 }, inferenceBinding: role => inferenceBindingFromPolicy(role, { model: 'synthetic-priced-model', inputRate: 10, outputRate: 20, maxOutput: 3200 }), maxSessionUsd: .1 });
    const session = (await service.createSession('owner', { requestId: key(), scenarioId: scenario.id })).session;
    await expect(service.requestAssistant('owner', session.id, { requestId: key(), expectedRevision: session.revision, mode: 'ask', message: 'Inspect' })).rejects.toMatchObject({ code: 'quota' });
    expect((await service.exportSession('owner', session.id)).jobs).toHaveLength(0);
  });
  it('retains the same report generation and binding through explicit retry and lease reclaim', async () => {
    const context = await admission('coach'), first = (await context.service.claimJob('first'))!;
    await context.service.failJob(first, 'Synthetic lost response.');
    vi.stubEnv('OPENAI_MODEL', 'replacement-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '100'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '100');
    await context.service.retryReport('owner', context.id, { requestId: key() }); const retry = (await context.service.claimJob('retry'))!;
    expect(retry.job.id).toBe(first.job.id); expect(retry.job.input).toEqual(first.job.input); expect(retry.job.reservedUsd).toBe(first.job.reservedUsd);
    context.clock.now = new Date(context.clock.now.getTime() + 1100); const reclaimed = (await context.service.claimJob('reclaimed'))!;
    expect(reclaimed.job.input).toEqual(first.job.input); expect(reclaimed.job.reservationSequence).toBe(3); expect(await context.service.completeJob(retry, { kind: 'coach', model: 'authored-observation-only', promptVersion: PROMPT_VERSION, report: observationOnlyReport(scenario), actualUsd: 0 })).toBe(false);
    const fetch = vi.fn().mockImplementation(() => response(observationOnlyReport(scenario))); vi.stubGlobal('fetch', fetch);
    const result = await coach(scenario, await context.service.exportSession('owner', context.id), undefined, parseInferenceBinding(reclaimed.job.input.inferenceBinding)!);
    expect(await context.service.completeJob(reclaimed, result)).toBe(true);
    const saved = await context.service.exportSession('owner', context.id);
    expect(saved.reports[0].generationId).toBe(first.job.input.generationId); expect(saved.usage.uncertainUsd).toBeCloseTo(first.job.reservedUsd * 2); expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe('gpt-5.4-mini');
  });
  it('preserves prior observed usage while unknown-cost retry fallback has no stale current metadata', async () => {
    const context = await admission('coach'), first = (await context.service.claimJob('first'))!, inference = { ...fixtureInference(first, .001), validated: false, providerRequestId: 'synthetic-first-call' };
    await context.service.failJob(first, 'Synthetic known-billed failure.', inference.usd, inference);
    await context.service.retryReport('owner', context.id, { requestId: key() });
    const queued = (await context.service.exportSession('owner', context.id)).jobs.at(-1)!;
    expect(queued.inference).toBeUndefined(); expect(queued.actualUsd).toBeUndefined(); expect(queued.attemptObservations).toEqual([{ attempt: 1, reservationSequence: 1, observedAt: context.clock.now.toISOString(), outcome: 'settled', actualUsd: inference.usd, inference }]);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic unknown response'))); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id), job = saved.jobs.at(-1)!;
    expect(job.state).toBe('completed'); expect(job.inference).toBeUndefined(); expect(job.actualUsd).toBeUndefined(); expect(job.attemptObservations).toEqual(queued.attemptObservations);
    expect(saved.usage).toMatchObject({ spentUsd: inference.usd, uncertainUsd: job.reservedUsd, reservedUsd: 0 });
    const view = await context.service.getJob('owner', job.id); expect(view.actualUsd).toBeUndefined(); expect(view).not.toHaveProperty('attemptObservations'); expect(JSON.stringify(view)).not.toContain('synthetic-first-call');
  });
  it('preserves known and uncertain prior attempts through a lease reclaim without overwriting provider identity', async () => {
    const context = await admission('coach'), first = (await context.service.claimJob('first'))!, inference = { ...fixtureInference(first, .001), validated: false, providerRequestId: 'synthetic-first-call' };
    await context.service.failJob(first, 'Synthetic known-billed failure.', inference.usd, inference); await context.service.retryReport('owner', context.id, { requestId: key() });
    const second = (await context.service.claimJob('second'))!; context.clock.now = new Date(context.clock.now.getTime() + 1100);
    const third = (await context.service.claimJob('third'))!, before = await context.service.exportSession('owner', context.id);
    expect(third.job.inference).toBeUndefined(); expect(third.job.actualUsd).toBeUndefined(); expect(third.job.attemptObservations?.map(row => [row.attempt, row.reservationSequence, row.outcome])).toEqual([[1, 1, 'settled'], [2, 2, 'uncertain']]);
    expect(third.job.attemptObservations?.[0].inference?.providerRequestId).toBe('synthetic-first-call'); expect(third.job.input).toEqual(first.job.input);
    expect(await context.service.completeJob(second, { kind: 'coach', report: observationOnlyReport(scenario), model: 'authored-observation-only', promptVersion: PROMPT_VERSION, actualUsd: 0 })).toBe(false);
    const current = { ...fixtureInference(third, .002), validated: false, providerRequestId: 'synthetic-third-call' };
    await context.service.failJob(third, 'Synthetic third response.', current.usd, current);
    const after = await context.service.exportSession('owner', context.id); expect(after.jobs.at(-1)!.attemptObservations).toEqual(before.jobs.at(-1)!.attemptObservations); expect(after.jobs.at(-1)!.inference?.providerRequestId).toBe('synthetic-third-call');
  });
  it('preserves historical queued retry metadata with an explicitly unknown reservation association', async () => {
    const context = await admission('coach'), first = (await context.service.claimJob('first'))!, inference = { ...fixtureInference(first, .001), validated: false };
    await context.service.failJob(first, 'Synthetic known-billed failure.', inference.usd, inference); await context.service.retryReport('owner', context.id, { requestId: key() });
    await context.store.transaction(db => { const job = db.sessions[context.id].jobs.at(-1)!; delete job.attemptObservations; job.inference = inference; job.actualUsd = inference.usd; });
    const second = (await context.service.claimJob('second'))!;
    expect(second.job.inference).toBeUndefined(); expect(second.job.actualUsd).toBeUndefined(); expect(second.job.attemptObservations).toEqual([{ attempt: 1, reservationSequence: null, observedAt: context.clock.now.toISOString(), outcome: 'legacy-unattributed', actualUsd: inference.usd, inference }]);
  });
  it('fails closed rather than truncating over-cap observed attempt history', async () => {
    const context = await admission('coach'), first = (await context.service.claimJob('first'))!; await context.service.failJob(first, 'Synthetic unknown response.');
    await context.store.transaction(db => { db.sessions[context.id].jobs.at(-1)!.attemptObservations = Array.from({ length: 3 }, (_, attempt) => ({ attempt, reservationSequence: null, observedAt: context.clock.now.toISOString(), outcome: 'legacy-unattributed' })); });
    const before = await context.store.read(); await expect(context.service.retryReport('owner', context.id, { requestId: key() })).rejects.toMatchObject({ code: 'unavailable' }); expect(await context.store.read()).toEqual(before);
  });
  it.each(['assistant', 'interviewer', 'coach'] as const)('never upgrades a legacy unbound %s job to today\'s paid policy', async kind => {
    const context = await admission(kind); await context.store.transaction(db => { const job = db.sessions[context.id].jobs.at(-1)!; delete job.input.inferenceBinding; job.fingerprint = digest(job.input); });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id), job = saved.jobs.at(-1)!;
    expect(fetch).not.toHaveBeenCalled(); expect(job.actualUsd).toBe(0); expect(job.input.inferenceBinding).toBeUndefined();
    expect(job.state).toBe(kind === 'assistant' ? 'failed' : 'completed');
    if (kind === 'coach') expect(saved.reports[0]).toMatchObject({ model: 'authored-observation-only', promptVersion: PROMPT_VERSION });
  });
  it.each(['promptVersion', 'schemaVersion', 'contextVersion'] as const)('falls back before inference for unsupported admitted %s', async field => {
    const context = await admission('coach'); await context.store.transaction(db => { const job = db.sessions[context.id].jobs.at(-1)!; (job.input.inferenceBinding as Record<string, unknown>)[field] = 'old-unsupported'; job.fingerprint = digest(job.input); });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id); expect(fetch).not.toHaveBeenCalled(); expect(saved.reports[0]).toMatchObject({ model: 'authored-observation-only', promptVersion: PROMPT_VERSION }); expect(saved.jobs.at(-1)!.inference).toBeUndefined();
  });
  it('rejects corrupted AI input fingerprints before any provider call, including forged authored mode', async () => {
    const context = await admission('assistant'); await context.store.transaction(db => { db.sessions[context.id].jobs[0].input.forceAuthored = true; });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await processOneJob(context.service);
    expect(fetch).not.toHaveBeenCalled(); expect((await context.service.getSession('owner', context.id)).jobs[0]).toMatchObject({ state: 'failed', actualUsd: 0 });
  });
  it.each(['OPENAI_API_KEY', 'FEATURE_AI_INTERVIEW'] as const)('respects immediate %s kill switch without replacing admitted policy', async name => {
    const context = await admission('interviewer'); vi.stubEnv(name, name === 'OPENAI_API_KEY' ? '' : 'false');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await processOneJob(context.service);
    const session = await context.service.getSession('owner', context.id); expect(fetch).not.toHaveBeenCalled(); expect(session.turns[0].source).toBe('authored'); expect(session.usage).toMatchObject({ spentUsd: 0, uncertainUsd: 0 });
  });
  it('keeps unknown paid failure cost while publishing only deterministic authored observations', async () => {
    const context = await admission('coach'); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic disconnection'))); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id); expect(saved.lifecycle).toBe('completed'); expect(saved.reports[0].model).toBe('authored-observation-only'); expect(saved.usage.uncertainUsd).toBe(saved.jobs.at(-1)!.reservedUsd); expect(saved.jobs.at(-1)!.actualUsd).toBeUndefined();
  });
  it('retains known admitted-price usage for invalid provider output before authored fallback', async () => {
    const context = await admission('coach'); vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response({ fabricated: true }))); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id); expect(saved.lifecycle).toBe('completed'); expect(saved.jobs.at(-1)!.inference).toMatchObject({ validated: false, usd: .000525 }); expect(saved.usage.spentUsd).toBe(.000525);
  });
  it.each(['coach', 'assistant'] as const)('retains known billed %s usage when the response breaches the admitted output limit', async kind => {
    const context = await admission(kind), before = await context.service.exportSession('owner', context.id), binding = parseInferenceBinding(before.jobs.at(-1)!.input.inferenceBinding)!;
    const outputTokens = binding.maxOutputTokens + 1, usd = (100 * binding.inputRate + outputTokens * binding.outputRate) / 1_000_000;
    const fetch = vi.fn().mockImplementation(() => response(kind === 'coach' ? observationOnlyReport(scenario) : { message: 'Do not publish this response.', files: [] }, { usage: { input_tokens: 100, output_tokens: outputTokens } })); vi.stubGlobal('fetch', fetch);
    expect(await processOneJob(context.service)).toBe(true);
    const saved = await context.service.exportSession('owner', context.id), job = saved.jobs.at(-1)!;
    expect(fetch).toHaveBeenCalledOnce(); expect(job.state).toBe(kind === 'coach' ? 'completed' : 'failed'); expect(job.inference).toMatchObject({ outputTokens, validated: false, usd });
    expect(job.actualUsd).toBe(usd); expect(saved.usage.spentUsd).toBe(usd); expect(saved.usage.uncertainUsd).toBe(0); expect(saved.usage.reservedUsd).toBe(0);
    if (kind === 'coach') expect(saved.reports[0].model).toBe('authored-observation-only'); else expect(saved.assistantMessages.filter(message => message.role === 'assistant')).toHaveLength(0);
  });
  it('never turns an admitted authored operation into a paid one after AI becomes available', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario, { inferenceBinding: () => null });
    const session = (await service.createSession('owner', { requestId: key(), scenarioId: scenario.id })).session;
    await service.command('owner', session.id, { requestId: key(), expectedRevision: session.revision, action: 'finish' });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await processOneJob(service);
    const saved = await service.exportSession('owner', session.id);
    expect(fetch).not.toHaveBeenCalled(); expect(saved.jobs[0].input).toMatchObject({ forceAuthored: true }); expect(saved.jobs[0].input.inferenceBinding).toBeUndefined(); expect(saved.usage).toMatchObject({ spentUsd: 0, uncertainUsd: 0 });
  });
  it.each(['binding', 'reservation'] as const)('rejects a caller-mutated claim %s before contacting the provider', async field => {
    const context = await admission('assistant'), claimJob = context.service.claimJob.bind(context.service);
    vi.spyOn(context.service, 'claimJob').mockImplementation(async workerId => {
      const claim = await claimJob(workerId);
      if (claim) { if (field === 'binding') { (claim.job.input.inferenceBinding as Record<string, unknown>).model = 'forged-claim-model'; claim.job.fingerprint = digest(claim.job.input); } else claim.job.reservedUsd = 0; }
      return claim;
    });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id); expect(fetch).not.toHaveBeenCalled(); expect(saved.jobs[0]).toMatchObject({ state: 'failed', actualUsd: 0 }); expect(saved.usage.uncertainUsd).toBe(0);
  });
  it('does not fabricate a returned model when provider identity is missing', async () => {
    const context = await admission('coach'); vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response(observationOnlyReport(scenario), { model: undefined }))); await processOneJob(context.service);
    const saved = await context.service.exportSession('owner', context.id); expect(saved.jobs.at(-1)!.inference).toBeUndefined(); expect(saved.usage.uncertainUsd).toBeGreaterThan(0);
  });
  it('preserves known billed usage when an assistant edit violates workspace policy', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario), session = (await service.createSession('owner', { requestId: key(), scenarioId: scenario.id })).session;
    await service.requestAssistant('owner', session.id, { requestId: key(), expectedRevision: session.revision, mode: 'edit', message: 'Synthetic edit request.' });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => response({ message: 'Do not publish this invalid patch.', files: [{ path: Object.keys(scenario.files)[0], content: '\0' }] })));
    await processOneJob(service); const saved = await service.exportSession('owner', session.id);
    expect(saved.jobs[0]).toMatchObject({ state: 'failed', actualUsd: .000525, inference: { validated: false, usd: .000525 } }); expect(saved.usage).toMatchObject({ spentUsd: .000525, uncertainUsd: 0 }); expect(saved.editProposals).toHaveLength(0);
  });
  it('keeps the exact admitted policy across a durable file-store restart without exposing it in owner DTOs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-inference-'));
    try { const context = await admission('assistant', new FilePracticeStore(directory)); const original = await context.service.exportSession('owner', context.id); const restarted = new SessionService(new FilePracticeStore(directory), getScenario); const saved = await restarted.exportSession('owner', context.id); expect(saved.jobs[0].input).toEqual(original.jobs[0].input); expect(JSON.stringify(await restarted.getSession('owner', context.id))).not.toContain('inferenceBinding'); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe('stored admission and completion provenance', () => {
  it('accepts a different returned snapshot only when it matches the recorded provider result', async () => {
    const context = await admission('assistant'), claim = (await context.service.claimJob('worker'))!, result = assistantResult(claim);
    expect(await context.service.completeJob(claim, result)).toBe(true);
  });
  const changes: Array<[string, (record: InferenceRecord) => void]> = [
    ['requested model', r => { r.requestedModel = 'other'; }], ['role', r => { r.role = 'coach'; }], ['provider', r => { r.provider = undefined; }],
    ['prompt', r => { r.promptVersion = 'other'; }], ['schema', r => { r.schemaVersion = 'other'; }], ['context', r => { r.contextVersion = 'other'; }], ['digest', r => { r.bindingDigest = '0'.repeat(64); }],
    ['fractional input', r => { r.inputTokens = .5; }], ['nonfinite input', r => { r.inputTokens = Infinity; }], ['input bound', r => { r.inputTokens = 1_000_000; }], ['output bound', r => { r.outputTokens = 3201; }], ['usd', r => { r.usd = .1; }],
  ];
  it.each(changes)('rejects %s provenance atomically', async (_name, change) => {
    const context = await admission('assistant'), claim = (await context.service.claimJob('worker'))!, result = assistantResult(claim), before = await context.store.read(); change(result.inference!);
    await expect(context.service.completeJob(claim, result)).rejects.toMatchObject({ code: 'invalid' }); expect(await context.store.read()).toEqual(before);
    await expect(context.service.failJob(claim, 'Synthetic failure', result.actualUsd, result.inference)).rejects.toMatchObject({ code: 'invalid' }); expect(await context.store.read()).toEqual(before);
  });
  it('rejects missing usage and a result model that differs from returned provenance', async () => {
    const context = await admission('assistant'), claim = (await context.service.claimJob('worker'))!, result = assistantResult(claim);
    await expect(context.service.completeJob(claim, { ...result, inference: undefined })).rejects.toMatchObject({ code: 'invalid' });
    await expect(context.service.completeJob(claim, { ...result, model: 'other-snapshot' })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('rejects a positive failed-operation settlement without recorded usage atomically', async () => {
    const context = await admission('assistant'), claim = (await context.service.claimJob('worker'))!, before = await context.store.read();
    await expect(context.service.failJob(claim, 'Synthetic failure', .01)).rejects.toMatchObject({ code: 'invalid' }); expect(await context.store.read()).toEqual(before);
    expect(await context.service.failJob(claim, 'Synthetic failure')).toBe(true);
    expect((await context.service.getSession('owner', context.id)).usage.uncertainUsd).toBe(claim.job.reservedUsd);
  });
  it.each(['force-authored', 'under-reserved'] as const)('rejects billed failed-operation usage for %s admission atomically', async mode => {
    const context = await admission('coach');
    await context.store.transaction(db => { const job = db.sessions[context.id].jobs.at(-1)!; job.reservedUsd = mode === 'force-authored' ? 0 : job.reservedUsd - .001; if (mode === 'force-authored') job.input.forceAuthored = true; job.fingerprint = digest(job.input); });
    const claim = (await context.service.claimJob('worker'))!, inference = { ...fixtureInference(claim, .001), validated: false }, before = await context.store.read();
    await expect(context.service.failJob(claim, 'Synthetic failure', inference.usd, inference)).rejects.toMatchObject({ code: 'invalid' }); expect(await context.store.read()).toEqual(before);
  });
  it('checks persisted admission instead of a caller-mutated claim policy', async () => {
    const context = await admission('assistant'), claim = (await context.service.claimJob('worker'))!;
    (claim.job.input.inferenceBinding as Record<string, unknown>).model = 'forged-claim-model';
    await expect(context.service.completeJob(claim, assistantResult(claim))).rejects.toMatchObject({ code: 'invalid' });
    const forged = assistantResult(claim);
    await expect(context.service.failJob(claim, 'Synthetic failure', forged.actualUsd, forged.inference)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('does not let an authored label publish a made-up assessment without provider provenance', async () => {
    const context = await admission('coach'), claim = (await context.service.claimJob('worker'))!, report = observationOnlyReport(scenario); report.overview = 'Invented assessment.';
    await expect(context.service.completeJob(claim, { kind: 'coach', model: 'authored-observation-only', promptVersion: PROMPT_VERSION, actualUsd: 0, report })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('rejects a weak reservation or unsupported role/version in a configured binding', () => {
    const valid = configuredInferenceBinding('assistant'); expect(parseInferenceBinding({ ...valid, reserveUsd: .001 })).toBeNull(); expect(parseInferenceBinding({ ...valid, extra: true })).toBeNull(); expect(parseInferenceBinding(valid, 'coach')).toBeNull();
  });
});
