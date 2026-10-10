import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { processOneJob } from '../lib/server/worker';
import * as operations from '../lib/server/operations';
import * as runtime from '../lib/runtime/runner';
import type { RunExecution } from '../lib/interview-practice/types';

beforeEach(() => {
  vi.stubEnv('FEATURE_PRACTICE_TELEMETRY', 'true');
  vi.stubEnv('PRACTICE_TELEMETRY_SINK', 'stdout');
  vi.stubEnv('PRACTICE_TELEMETRY_SECRET', 'telemetry-only-unit-secret-32-characters');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const failure = (): RunExecution => ({ status: 'infrastructure_error', command: 'unit fixture, no execution', stdout: '', stderr: 'Unit failure.', exitCode: null, tests: [], durationMs: 0 });

describe('worker observation acceptance boundaries', () => {
  it('emits provision and failed-result observations only after their distinct acknowledgements', async () => {
    const records: Record<string, unknown>[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => records.push(JSON.parse(line)));
    vi.spyOn(operations, 'executionAdmissionOpen').mockResolvedValue(true);
    vi.spyOn(runtime, 'runnerHealth').mockReturnValue({ configured: true, admitting: true, blockedReason: null });
    vi.spyOn(runtime, 'executeScenario').mockImplementation(async (_scenario, _files, options) => {
      options?.onProvision?.(12, 0); return failure();
    });
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const session = (await service.createSession('private-owner', { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
    const admitted = await service.requestRun('private-owner', session.id, { requestId: randomUUID(), expectedRevision: session.revision });
    await processOneJob(service);
    expect((await service.getSession('private-owner', session.id)).runs[0].status).toBe('infrastructure_error');
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'server', metric: 'job.queue', jobKind: 'run' }),
      expect.objectContaining({ origin: 'server', metric: 'sandbox.provision', durationMs: 12, outcome: 'acknowledged' }),
      expect.objectContaining({ origin: 'server', metric: 'run.result', outcome: 'failed' }),
    ]));
    const content = JSON.stringify(records);
    for (const secret of ['private-owner', session.id, admitted.job!.id, 'Unit failure.', 'quote.py']) expect(content).not.toContain(secret);
  });

  it('does not emit an accepted result after deletion invalidates a running claim', async () => {
    const records: Record<string, unknown>[] = [];
    vi.spyOn(console, 'info').mockImplementation(line => records.push(JSON.parse(line)));
    vi.spyOn(operations, 'executionAdmissionOpen').mockResolvedValue(true);
    vi.spyOn(runtime, 'runnerHealth').mockReturnValue({ configured: true, admitting: true, blockedReason: null });
    let resolve!: (run: RunExecution) => void, started!: () => void;
    const called = new Promise<void>(yes => { started = yes; });
    vi.spyOn(runtime, 'executeScenario').mockImplementation(() => { started(); return new Promise<RunExecution>(yes => { resolve = yes; }); });
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const session = (await service.createSession('owner', { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
    await service.requestRun('owner', session.id, { requestId: randomUUID(), expectedRevision: session.revision });
    const pending = processOneJob(service); await called;
    await service.deleteSession('owner', session.id, { requestId: randomUUID() });
    resolve(failure()); await pending;
    expect(await service.listSessions('owner')).toEqual([]);
    expect(records.some(row => row.metric === 'job.queue')).toBe(true);
    expect(records.some(row => row.metric === 'run.result')).toBe(false);
  });

  it('a broken diagnostic sink cannot discard an accepted observation-only report', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('Unit collector outage'); });
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const service = new SessionService(new MemoryPracticeStore(), getScenario, { maxSessionUsd: 0.001 });
      let session = (await service.createSession('owner', { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
      await service.command('owner', session.id, { requestId: randomUUID(), expectedRevision: session.revision, action: 'finish' });
      await processOneJob(service); session = await service.getSession('owner', session.id);
      await service.command('owner', session.id, { requestId: randomUUID(), expectedRevision: session.revision, action: 'submit' });
      await processOneJob(service); session = await service.getSession('owner', session.id);
      expect(session.lifecycle).toBe('completed');
      expect(session.reports[0].rubric.every(row => row.level === 'Not observed')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
