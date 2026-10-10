import { fixtureRuntimeId } from './runtime-fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as content from '../lib/content/scenarios';
import * as runtime from '../lib/runtime/runner';
import * as operations from '../lib/server/operations';
import { digest } from '../lib/interview-practice/domain';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { processOneJob } from '../lib/server/worker';

const original = content.getScenario('monetary-validation')!;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function admitted(kind: 'assistant' | 'run') {
  const store = new MemoryPracticeStore();
  const service = new SessionService(store, content.getScenario);
  const session = (await service.createSession('owner', { scenarioId: original.id, requestId: 'admission-create' })).session;
  const input = { expectedRevision: session.revision, requestId: 'admission-operation' };
  const result = kind === 'run' ? await service.requestRun('owner', session.id, input)
    : await service.requestAssistant('owner', session.id, { ...input, mode: 'ask', message: 'Review this code' });
  return { store, service, id: session.id, jobId: result.job!.id };
}

const variants = [
  ['private test source', (s: typeof original) => { s.tests[0].source += '\n# changed\n'; }],
  ['runtime policy', (s: typeof original) => { s.runtime.memoryMb += 1; }],
  ['reference solution', (s: typeof original) => { s.referenceFiles['quote.py'] += '\n# changed\n'; }],
] as const;

describe('worker verifies admitted inputs before external work', () => {
  for (const kind of ['assistant', 'run'] as const) for (const [name, change] of variants) {
    it(`rejects changed ${name} for ${kind} without invoking a provider or runner`, async () => {
      const { service, id, store } = await admitted(kind);
      const changed = structuredClone(original); change(changed);
      vi.spyOn(content, 'getScenario').mockReturnValue(changed);
      const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
      const execute = vi.spyOn(runtime, 'executeScenario');
      expect(await processOneJob(service)).toBe(true);
      const saved = await service.getSession('owner', id);
      expect(saved.jobs[0]).toMatchObject({ state: 'failed', actualUsd: 0 });
      expect(saved.jobs[0].safeError).toContain('No execution or inference started');
      expect(saved.usage).toMatchObject({ spentUsd: 0, reservedUsd: 0, uncertainUsd: 0 });
      expect((await store.read()).ledger.at(-1)).toMatchObject({ kind: 'settlement', amountUsd: kind === 'assistant' ? -0.08 : 0 });
      expect(fetch).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
      expect(saved.runs).toEqual([]); expect(saved.assistantMessages.filter(m => m.role === 'assistant')).toEqual([]);
    });
  }
  it('releases an uncalled reservation when the original package is missing', async () => {
    const { service, id } = await admitted('assistant');
    vi.spyOn(content, 'getScenario').mockReturnValue(null);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await processOneJob(service);
    expect((await service.getSession('owner', id)).jobs[0]).toMatchObject({ state: 'failed', actualUsd: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  for (const corruption of ['snapshot', 'suite', 'runtime'] as const) it(`rejects corrupted admitted ${corruption} before execution`, async () => {
    const { store, service, id } = await admitted('run');
    await store.transaction(db => {
      const session = db.sessions[id];
      if (corruption === 'snapshot') session.snapshots[0].files['quote.py'] += '\n# tampered';
      else if (corruption === 'suite') session.jobs[0].input.testSuiteDigest = digest([]);
      else session.jobs[0].input.runtime = { ...original.runtime, memoryMb: 512 };
    });
    const execute = vi.spyOn(runtime, 'executeScenario');
    await processOneJob(service);
    expect((await service.getSession('owner', id)).jobs[0]).toMatchObject({ state: 'failed', actualUsd: 0 });
    expect(execute).not.toHaveBeenCalled();
  });
  it('executes the unchanged admitted package and snapshot', async () => {
    const { service, id } = await admitted('run');
    vi.spyOn(operations, 'executionAdmissionOpen').mockResolvedValue(true);
    vi.spyOn(runtime, 'runnerHealth').mockReturnValue({ configured: true, admitting: true, blockedReason: null });
    const execute = vi.spyOn(runtime, 'executeScenario').mockResolvedValue({ runtimeDigest: fixtureRuntimeId, status: 'completed', command: 'fixture', stdout: '', stderr: '', exitCode: 0, tests: [], durationMs: 1 });
    await processOneJob(service);
    expect(execute).toHaveBeenCalledOnce();
    expect((await service.getSession('owner', id)).jobs[0].state).toBe('completed');
  });
});
