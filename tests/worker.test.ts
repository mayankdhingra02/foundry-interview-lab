import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { processOneJob } from '../lib/server/worker';
import * as operations from '../lib/server/operations';
import * as runtime from '../lib/runtime/runner';

const scenario = getScenario('monetary-validation')!;
let counter = 0;
const requestId = () => `worker-test-${++counter}`;
beforeEach(() => { vi.stubEnv('OPENAI_API_KEY', 'fixture-not-a-real-key'); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const response = (files: Array<{path:string;content:string}> = []) => new Response(JSON.stringify({ status: 'completed', model: 'fixture-model', usage: { input_tokens: 100, output_tokens: 100 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ message: 'Fixture proposal', files }) }] }] }));

describe('durable worker integration', () => {
  it('does not execute already queued work when shared operational admission closes', async () => {
    vi.spyOn(operations, 'executionAdmissionOpen').mockResolvedValue(false);
    const execute = vi.spyOn(runtime, 'executeScenario');
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const session = (await service.createSession('owner', { scenarioId: scenario.id, requestId: requestId() })).session;
    await service.requestRun('owner', session.id, { requestId: requestId(), expectedRevision: session.revision });
    await processOneJob(service);
    const saved = await service.getSession('owner', session.id);
    expect(execute).not.toHaveBeenCalled();
    expect(saved.runs[0]).toMatchObject({ status: 'infrastructure_error', tests: [], exitCode: null });
  });
  it('shares a cleanup hold while retaining the actual failed execution observation', async () => {
    vi.spyOn(operations, 'executionAdmissionOpen').mockResolvedValue(true);
    const block = vi.spyOn(operations, 'blockExecutionAdmission').mockResolvedValue();
    vi.spyOn(runtime, 'runnerHealth').mockReturnValue({ configured: true, admitting: false, blockedReason: 'cleanup_unconfirmed' });
    vi.spyOn(runtime, 'executeScenario').mockResolvedValue({ status: 'infrastructure_error', command: 'fixture execution', stdout: '', stderr: 'Cleanup unconfirmed.', exitCode: null, tests: [], durationMs: 10 });
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const session = (await service.createSession('owner', { scenarioId: scenario.id, requestId: requestId() })).session;
    await service.requestRun('owner', session.id, { requestId: requestId(), expectedRevision: session.revision });
    await processOneJob(service);
    expect(block).toHaveBeenCalledOnce();
    expect((await service.getSession('owner', session.id)).runs[0].stderr).toBe('Cleanup unconfirmed.');
  });
  it('finishes debrief and produces an unassessed report when quota cannot fund inference', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const service = new SessionService(new MemoryPracticeStore(), getScenario, { maxSessionUsd: 0.001 });
    let session = (await service.createSession('owner', { scenarioId: scenario.id, requestId: requestId() })).session;
    const finish = await service.command('owner', session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'finish' });
    expect(finish.job?.reservedUsd).toBe(0); await processOneJob(service);
    session = await service.getSession('owner', session.id);
    await service.command('owner', session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'submit' });
    await processOneJob(service); session = await service.getSession('owner', session.id);
    expect(session.lifecycle).toBe('completed'); expect(session.reports[0].rubric.every(r => r.level === 'Not observed')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('packages the admitted assistant snapshot and rejects acceptance over later manual work', async () => {
    const fetch = vi.fn().mockImplementation(async () => response([{ path: 'quote.py', content: '# proposed\n' }])); vi.stubGlobal('fetch', fetch);
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    let session = (await service.createSession('owner', { scenarioId: scenario.id, requestId: requestId() })).session;
    session = (await service.requestAssistant('owner', session.id, { requestId: requestId(), expectedRevision: session.revision, mode: 'edit', message: 'Inspect' })).session;
    await service.saveWorkspace('owner', session.id, { requestId: requestId(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# newer manual work\n' } });
    await processOneJob(service); session = await service.getSession('owner', session.id);
    const sent = JSON.parse(JSON.parse(fetch.mock.calls[0][1].body).input[0].content);
    expect(sent.files['quote.py']).toBe(scenario.files['quote.py']);
    await expect(service.decideEdit('owner', session.id, { requestId: requestId(), expectedRevision: session.revision, proposalId: session.editProposals[0].id, decision: 'accept' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('discards a provider result when its session was deleted during inference', async () => {
    let resolve!: (value:Response) => void, admitted!: () => void;
    const called = new Promise<void>(r => { admitted = r; });
    vi.stubGlobal('fetch', vi.fn(() => { admitted(); return new Promise<Response>(r => { resolve = r; }); }));
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const session = (await service.createSession('owner', { scenarioId: scenario.id, requestId: requestId() })).session;
    await service.requestAssistant('owner', session.id, { requestId: requestId(), expectedRevision: session.revision, mode: 'ask', message: 'Inspect' });
    const pending = processOneJob(service); await called;
    await service.deleteSession('owner', session.id, { requestId: requestId() }); resolve(response()); await pending;
    expect(await service.listSessions('owner')).toEqual([]);
  });
  it('enforces the global spend cap across different owners atomically', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario, { maxGlobalDailyUsd: 0.08 });
    const a = (await service.createSession('a', { scenarioId: scenario.id, requestId: requestId() })).session;
    const b = (await service.createSession('b', { scenarioId: scenario.id, requestId: requestId() })).session;
    const results = await Promise.allSettled([service.requestAssistant('a', a.id, { requestId: requestId(), expectedRevision: a.revision, mode: 'ask', message: 'Help' }), service.requestAssistant('b', b.id, { requestId: requestId(), expectedRevision: b.revision, mode: 'ask', message: 'Help' })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    // Once claimed, inference may have incurred a charge; deletion must keep
    // that global commitment. Unclaimed queued work is safely released.
    expect(await service.claimJob('fixture-worker')).not.toBeNull();
    await service.deleteAccount('a', { requestId: requestId() }); await service.deleteAccount('b', { requestId: requestId() });
    const c = (await service.createSession('c', { scenarioId: scenario.id, requestId: requestId() })).session;
    await expect(service.requestAssistant('c', c.id, { requestId: requestId(), expectedRevision: c.revision, mode: 'ask', message: 'Help' })).rejects.toMatchObject({ code: 'quota' });
  });
});
