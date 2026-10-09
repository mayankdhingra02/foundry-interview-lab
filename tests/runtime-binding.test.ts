import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import type { RunExecution } from '../lib/interview-practice/types';
import type * as Binding from '../lib/runtime/binding';
import * as runtime from '../lib/runtime/runner';
import * as operations from '../lib/server/operations';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { processOneJob } from '../lib/server/worker';
import { fixtureRuntimeBinding, fixtureRuntimeId } from './runtime-fixtures';

const binding = await vi.importActual<typeof Binding>('../lib/runtime/binding');
const scenario = () => getScenario('monetary-validation')!;
const otherId = `sha256:${'c'.repeat(64)}`;
let sequence = 0;
const req = () => `runtime-${++sequence}`;
const mutation = (revision: number) => ({ expectedRevision: revision, requestId: req() });
const completed = (runtimeDigest?: string): RunExecution => ({ status: 'completed',command: 'synthetic runtime fixture',stdout: '',stderr: '',exitCode: 0,tests: [],durationMs: 1,...(runtimeDigest ? { runtimeDigest } : {}) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('trusted runtime configuration', () => {
  it.each(['development','production'])('requires an explicit immutable ID in %s with no alias fallback', mode => {
    expect(binding.configuredRuntimeBinding(scenario(),{ NODE_ENV: mode })).toBeNull();
    expect(binding.runtimeBindingConfigured({ NODE_ENV: mode })).toBe(false);
    for (const imageId of ['python:3.11-slim','sha256:abcd',`sha256:${'A'.repeat(64)}`]) expect(binding.configuredRuntimeBinding(scenario(),{ PYTHON_IMAGE_ID: imageId })).toBeNull();
  });
  it('maps only an approved authored profile and operator alias to the explicit ID', () => {
    const env = { PYTHON_IMAGE: 'reviewed/python:2026',PYTHON_IMAGE_ID: fixtureRuntimeId,RUNNER_ALLOWED_IMAGES: 'python:3.11-slim,reviewed/python:2026' };
    expect(binding.configuredRuntimeBinding(scenario(),env)).toEqual({ version: 1,scenarioImage: scenario().runtime.image,imageAlias: env.PYTHON_IMAGE,imageId: fixtureRuntimeId });
    expect(binding.configuredRuntimeBinding(scenario(),{ ...env,RUNNER_ALLOWED_IMAGES: env.PYTHON_IMAGE })).toBeNull();
    expect(binding.configuredRuntimeBinding(scenario(),{ ...env,PYTHON_IMAGE: 'foreign:latest' })).toBeNull();
  });
  it('validates frozen bindings without consulting later environment changes', () => {
    const saved = fixtureRuntimeBinding(scenario());
    vi.stubEnv('PYTHON_IMAGE_ID',otherId); vi.stubEnv('PYTHON_IMAGE','foreign:latest');
    expect(binding.parseRuntimeBinding(saved,scenario().runtime.image)).toEqual(saved);
    expect(binding.parseRuntimeBinding(saved,'foreign:latest')).toBeNull();
    expect(binding.parseRuntimeBinding({ ...saved,version: 2 },scenario().runtime.image)).toBeNull();
    expect(binding.parseRuntimeBinding({ ...saved,imageAlias: '../bad image' },scenario().runtime.image)).toBeNull();
  });
});

describe('runtime binding at durable run admission', () => {
  it('rejects missing bindings atomically before jobs, quotas, events or request caches change', async () => {
    const store = new MemoryPracticeStore(), resolver = vi.fn(() => null);
    const service = new SessionService(store,getScenario,{ runtimeBinding: resolver });
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    const before = await store.read();
    await expect(service.requestRun('owner',session.id,mutation(session.revision))).rejects.toMatchObject({ code: 'unavailable' });
    expect(resolver).toHaveBeenCalledOnce();
    expect(await store.read()).toEqual(before);
  });
  it('keeps the same snapshot, binding and job fingerprint across replay and lease takeover', async () => {
    const store = new MemoryPracticeStore(); let now = new Date('2026-10-09T12:00:00Z'), current = fixtureRuntimeId;
    const resolver = vi.fn(() => ({ ...fixtureRuntimeBinding(scenario()),imageId: current }));
    const service = new SessionService(store,getScenario,{ runtimeBinding: resolver,now: () => now,leaseMs: 1000 });
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    const input = mutation(session.revision), admitted = await service.requestRun('owner',session.id,input);
    const first = await service.claimJob('first');
    current = otherId;
    expect(await service.requestRun('owner',session.id,input)).toEqual(admitted);
    expect(resolver).toHaveBeenCalledOnce();
    now = new Date(now.getTime() + 1100);
    const next = await service.claimJob('next');
    expect(next!.job.input).toEqual(first!.job.input);
    expect(next!.job.snapshotId).toBe(first!.job.snapshotId);
    expect(next!.job.fingerprint).toBe(first!.job.fingerprint);
    expect(next!.job.input.runtimeBinding).toMatchObject({ imageId: fixtureRuntimeId });
    expect(next!.fencingToken).toBeGreaterThan(first!.fencingToken);
  });
  it.each([undefined,otherId])('rejects completed evidence with absent or different runtime ID (%s) without accepting results', async runtimeId => {
    const store = new MemoryPracticeStore(), service = new SessionService(store,getScenario,{ runtimeBinding: fixtureRuntimeBinding });
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    await service.requestRun('owner',session.id,mutation(session.revision));
    const claim = (await service.claimJob('worker'))!, before = await store.read();
    await expect(service.completeJob(claim,{ kind: 'run',run: completed(runtimeId) })).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.read()).toEqual(before);
    await expect(service.completeJob(claim,{ kind: 'run',run: completed(fixtureRuntimeId) })).resolves.toBe(true);
  });
  it('requires the admitted ID for partial observations but permits an unexecuted infrastructure outcome', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store,getScenario);
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    await service.requestRun('owner',session.id,mutation(session.revision));
    const claim = (await service.claimJob('worker'))!;
    const observation = scenario().tests[0];
    await expect(service.completeJob(claim,{ kind: 'run',run: { ...completed(),status: 'timeout',exitCode: null,tests: [{ id: observation.id,title: observation.title,status: 'passed' }] } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(service.completeJob(claim,{ kind: 'run',run: { ...completed(),status: 'infrastructure_error',exitCode: null,stderr: 'Runtime not available',tests: [] } })).resolves.toBe(true);
    expect((await service.getSession('owner',session.id)).runs[0].runtimeDigest).toBeUndefined();
  });
  it('keeps historical observations without a runtime ID readable', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store,getScenario);
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    await service.requestRun('owner',session.id,mutation(session.revision));
    const claim = (await service.claimJob('worker'))!;
    await service.completeJob(claim,{ kind: 'run',run: completed(fixtureRuntimeId) });
    await store.transaction(db => { delete db.sessions[session.id].runs[0].runtimeDigest; });
    expect((await service.getSession('owner',session.id)).runs[0].status).toBe('completed');
    expect((await service.exportSession('owner',session.id)).runs[0].runtimeDigest).toBeUndefined();
  });
});

describe('runtime worker migration and forwarding', () => {
  it('fails an unbound legacy queued job without external work and requires an explicit new bound run', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store,getScenario);
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    await service.requestRun('owner',session.id,mutation(session.revision));
    await store.transaction(db => {
      const job = db.sessions[session.id].jobs[0]; delete job.input.runtimeBinding; job.fingerprint = digest(job.input);
    });
    const execute = vi.spyOn(runtime,'executeScenario'), fetch = vi.fn(); vi.stubGlobal('fetch',fetch);
    try {
      await processOneJob(service);
      const failed = await service.getSession('owner',session.id);
      expect(failed.jobs[0]).toMatchObject({ state: 'failed',actualUsd: 0 });
      expect(failed.jobs[0].safeError).toContain('predates immutable runtime admission');
      expect(failed.runs).toEqual([]); expect(execute).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      const next = await service.requestRun('owner',session.id,mutation(failed.revision));
      expect(next.job!.id).not.toBe(failed.jobs[0].id);
      expect((await service.exportSession('owner',session.id)).jobs.at(-1)!.input.runtimeBinding).toMatchObject({ imageId: fixtureRuntimeId });
    } finally { vi.unstubAllGlobals(); }
  });
  it('forwards the frozen ID to execution after operator configuration changes', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store,getScenario,{ runtimeBinding: fixtureRuntimeBinding });
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    await service.requestRun('owner',session.id,mutation(session.revision));
    vi.stubEnv('PYTHON_IMAGE_ID',otherId);
    vi.spyOn(operations,'executionAdmissionOpen').mockResolvedValue(true);
    vi.spyOn(runtime,'runnerHealth').mockReturnValue({ configured: true,admitting: true,blockedReason: null });
    const execute = vi.spyOn(runtime,'executeScenario').mockResolvedValue(completed(fixtureRuntimeId));
    await processOneJob(service);
    expect(execute.mock.calls[0][2]!.runtimeBinding).toEqual(fixtureRuntimeBinding(scenario()));
    expect((await service.getSession('owner',session.id)).runs[0].runtimeDigest).toBe(fixtureRuntimeId);
  });
  it('does not convert missing new-run configuration into an unclean-execution hold for an older pinned run', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store,getScenario,{ runtimeBinding: fixtureRuntimeBinding });
    const session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: req() })).session;
    await service.requestRun('owner',session.id,mutation(session.revision));
    vi.stubEnv('PYTHON_IMAGE_ID','');
    vi.spyOn(operations,'executionAdmissionOpen').mockResolvedValue(true);
    const block = vi.spyOn(operations,'blockExecutionAdmission').mockResolvedValue();
    vi.spyOn(runtime,'executeScenario').mockResolvedValue(completed(fixtureRuntimeId));
    expect(runtime.runnerHealth()).toMatchObject({ configured: false,admitting: false,blockedReason: null });
    await processOneJob(service);
    expect((await service.getSession('owner',session.id)).runs[0].runtimeDigest).toBe(fixtureRuntimeId);
    expect(block).not.toHaveBeenCalled();
  });
});
