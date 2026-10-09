import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { localIdentityCookie } from '../lib/server/auth';
import { practiceApi } from '../lib/server/practice-api';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import type { PracticeDatabase } from '../lib/interview-practice/types';

let service: SessionService;
const operations = vi.hoisted(() => ({ executionAdmissionOpen: vi.fn() }));
vi.mock('../lib/server/application', () => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker', () => ({ kickLocalWorker: vi.fn() }));
vi.mock('../lib/server/operations', () => operations);

class TransactionObservedStore extends MemoryPracticeStore {
  insideTransaction = false;
  override transaction<T>(operation: (database: PracticeDatabase) => T | Promise<T>): Promise<T> {
    return super.transaction(async database => {
      this.insideTransaction = true;
      try { return await operation(database); }
      finally { this.insideTransaction = false; }
    });
  }
}

let store: TransactionObservedStore, cookie: string, ownerId: string, serial = 0;
const nextKey = () => `replay-capability-${++serial}`;
async function api(path: string, body: unknown, identity = cookie, method = 'POST') {
  return practiceApi(new Request(`http://127.0.0.1:3000/api/interview-practice/${path}`, {
    method, headers: { origin: 'http://127.0.0.1:3000', cookie: identity, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), path.split('/'));
}
async function create() {
  const result = await service.createSession(ownerId, { scenarioId: 'monetary-validation', requestId: nextKey(), aiHelp: true });
  return result.session;
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'r'.repeat(32));
  vi.stubEnv('APP_URL', 'http://127.0.0.1:3000'); vi.stubEnv('OPENAI_API_KEY', 'synthetic-never-called');
  vi.stubEnv('FEATURE_AI_INTERVIEW', 'true'); vi.stubEnv('FEATURE_EXECUTION', 'true');
  store = new TransactionObservedStore(); service = new SessionService(store, getScenario);
  const identity = localIdentityCookie(); cookie = identity.cookie; ownerId = identity.actor.id;
  operations.executionAdmissionOpen.mockReset().mockImplementation(async () => {
    expect(store.insideTransaction).toBe(false);
    return true;
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('replay precedes fresh-work capability and operational admission', () => {
  it('returns the original run acknowledgement after execution and immutable runtime configuration are removed', async () => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision };
    const originalResponse = await api(`sessions/${session.id}/runs`, input);
    expect(originalResponse.status).toBe(202); const original = await originalResponse.json();
    const admitted = await store.read();
    vi.stubEnv('FEATURE_EXECUTION', 'false'); vi.stubEnv('PYTHON_IMAGE_ID', 'unconfigured');
    const replayResponse = await api(`sessions/${session.id}/runs`, input);
    expect(replayResponse.status).toBe(202); const replay = await replayResponse.json();
    expect(replay.job).toEqual(original.job); expect(replay.session).toEqual(original.session);
    expect(replay.capabilities.runner).toBe(false);
    const fresh = await api(`sessions/${session.id}/runs`, { ...input, requestId: nextKey(), expectedRevision: original.session.revision });
    expect(fresh.status).toBe(503); expect((await fresh.json()).error.code).toBe('runner_unavailable');
    expect(await store.read()).toEqual(admitted);
  });

  it('replays a run during a shared operational hold but rejects a new request without any extra charge or evidence', async () => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision };
    const original = await (await api(`sessions/${session.id}/runs`, input)).json(), admitted = await store.read();
    operations.executionAdmissionOpen.mockImplementation(async () => {
      expect(store.insideTransaction).toBe(false); return false;
    });
    const replay = await api(`sessions/${session.id}/runs`, input);
    expect(replay.status).toBe(202); expect((await replay.json()).job).toEqual(original.job);
    const fresh = await api(`sessions/${session.id}/runs`, { requestId: nextKey(), expectedRevision: original.session.revision });
    expect(fresh.status).toBe(503); expect(await store.read()).toEqual(admitted);
    expect(operations.executionAdmissionOpen).toHaveBeenCalledTimes(3);
  });

  it('keeps acknowledged replay available when the operational read itself fails, with no database calls inside the guard', async () => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision };
    const original = await (await api(`sessions/${session.id}/runs`, input)).json(), admitted = await store.read();
    operations.executionAdmissionOpen.mockImplementation(async () => {
      expect(store.insideTransaction).toBe(false); throw new Error('synthetic operations storage failure');
    });
    const replay = await api(`sessions/${session.id}/runs`, input);
    expect(replay.status).toBe(202); expect((await replay.json()).job).toEqual(original.job);
    expect((await api(`sessions/${session.id}/runs`, { requestId: nextKey(), expectedRevision: original.session.revision })).status).toBe(503);
    expect(await store.read()).toEqual(admitted);
  });

  it('replays an assistant acknowledgement after the AI flag and provider credential are removed', async () => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision, mode: 'ask', message: 'Explain the public validation requirement.' };
    const originalResponse = await api(`sessions/${session.id}/assistant`, input);
    expect(originalResponse.status).toBe(202); const original = await originalResponse.json(), admitted = await store.read();
    vi.stubEnv('FEATURE_AI_INTERVIEW', 'false'); vi.stubEnv('OPENAI_API_KEY', '');
    const replay = await api(`sessions/${session.id}/assistant`, input);
    expect(replay.status).toBe(202); const value = await replay.json();
    expect(value.job).toEqual(original.job); expect(value.session).toEqual(original.session); expect(value.capabilities.assistant).toBe(false);
    const fresh = await api(`sessions/${session.id}/assistant`, { ...input, requestId: nextKey(), expectedRevision: original.session.revision });
    expect(fresh.status).toBe(503); expect((await fresh.json()).error.code).toBe('assistant_unavailable');
    expect(await store.read()).toEqual(admitted); expect(operations.executionAdmissionOpen).not.toHaveBeenCalled();
  });

  it('returns 409 for a changed assistant payload even when assistance is now unavailable', async () => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision, mode: 'ask', message: 'Explain the task.' };
    expect((await api(`sessions/${session.id}/assistant`, input)).status).toBe(202);
    const admitted = await store.read(); vi.stubEnv('FEATURE_AI_INTERVIEW', 'false');
    const changed = await api(`sessions/${session.id}/assistant`, { ...input, message: 'Replace the original request.' });
    expect(changed.status).toBe(409); expect((await changed.json()).error.code).toBe('conflict');
    expect(await store.read()).toEqual(admitted);
  });

  it('keeps an existing key tied to its original operation while capabilities are disabled', async () => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision };
    expect((await api(`sessions/${session.id}/runs`, input)).status).toBe(202);
    vi.stubEnv('FEATURE_AI_INTERVIEW', 'false');
    expect((await api(`sessions/${session.id}/assistant`, { ...input, mode: 'ask', message: 'Different operation.' })).status).toBe(409);
  });

  it.each(['runs', 'assistant'] as const)('does not replay another owner’s %s acknowledgement or reveal unavailable admission', async operation => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision, ...(operation === 'assistant' ? { mode: 'ask', message: 'Explain the task.' } : {}) };
    expect((await api(`sessions/${session.id}/${operation}`, input)).status).toBe(202);
    const admitted = await store.read(); vi.stubEnv('FEATURE_AI_INTERVIEW', 'false'); vi.stubEnv('FEATURE_EXECUTION', 'false');
    const other = localIdentityCookie().cookie;
    const response = await api(`sessions/${session.id}/${operation}`, input, other);
    expect(response.status).toBe(404); expect((await response.json()).error.code).toBe('not_found');
    expect((await api(`sessions/nonexistent/${operation}`, { ...input, requestId: nextKey() }, other)).status).toBe(404);
    expect(await store.read()).toEqual(admitted);
  });

  it.each(['runs', 'assistant'] as const)('returns the erased-request result before unavailable %s admission and never restores content', async operation => {
    const session = await create(), input = { requestId: nextKey(), expectedRevision: session.revision, ...(operation === 'assistant' ? { mode: 'ask', message: 'Explain the task.' } : {}) };
    expect((await api(`sessions/${session.id}/${operation}`, input)).status).toBe(202);
    await service.deleteSession(ownerId, session.id, { requestId: nextKey() });
    const deleted = await store.read(); vi.stubEnv('FEATURE_AI_INTERVIEW', 'false'); vi.stubEnv('FEATURE_EXECUTION', 'false');
    const replay = await api(`sessions/${session.id}/${operation}`, input);
    expect(replay.status).toBe(410); expect((await replay.json()).error.code).toBe('request_deleted');
    if (operation === 'assistant') {
      const changed = await api(`sessions/${session.id}/${operation}`, { ...input, message: 'Changed erased request.' });
      expect(changed.status).toBe(409);
    }
    expect((await api(`sessions/${session.id}/${operation}`, { ...input, requestId: nextKey() })).status).toBe(404);
    expect(await store.read()).toEqual(deleted);
  });
});
