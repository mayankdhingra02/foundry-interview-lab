import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { localIdentityCookie } from '../lib/server/auth';
import { practiceApi } from '../lib/server/practice-api';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
let service: SessionService, cookie: string;
vi.mock('../lib/server/application', () => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker', () => ({ kickLocalWorker: vi.fn() }));
async function api(path: string, body: unknown, identity: string | null = cookie) {
  return practiceApi(new Request(`http://127.0.0.1:3000/api/interview-practice/${path}`, { method: 'POST', headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json', ...(identity ? { cookie: identity } : {}) }, body: JSON.stringify(body) }), path.split('/'));
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'b'.repeat(32)); vi.stubEnv('APP_URL', 'http://127.0.0.1:3000'); vi.stubEnv('OPENAI_API_KEY', '');
  cookie = localIdentityCookie().cookie; service = new SessionService(new MemoryPracticeStore(), getScenario);
});
afterEach(() => vi.unstubAllEnvs());
describe('timing HTTP authorization and exact recovery', () => {
  it('persists typed choices and rejects written-only voice or unknown free text', async () => {
    const request = { scenarioId: 'monetary-validation', requestId: randomUUID(), targetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' } };
    const first = await api('sessions', request); expect(first.status).toBe(201);
    const selected = (await first.json()).session;
    expect(selected.configuration).toMatchObject({ originalTargetMinutes: 60, targetMinutes: 60, practiceConditions: request.practiceConditions, voice: false });
    expect((await (await api('sessions', request)).json()).session.id).toBe(selected.id);
    expect((await api('sessions', { ...request, requestId: randomUUID(), voice: true })).status).toBe(400);
    expect((await api('sessions', { ...request, requestId: randomUUID(), practiceConditions: { ...request.practiceConditions, diagnosis: 'PRIVATE' } })).status).toBe(400);
  });
  it('replays a lost acknowledgement with the original amount and key after revision advances', async () => {
    const created = await api('sessions', { scenarioId: 'monetary-validation', requestId: randomUUID(), targetMinutes: 45 });
    const { session } = await created.json(), path = `sessions/${session.id}/timing`;
    const body = { requestId: randomUUID(), expectedRevision: session.revision, additionalMinutes: 30 };
    const result = await api(path, body); expect(result.status).toBe(200); const original = await result.json();
    expect(original.session.configuration).toMatchObject({ originalTargetMinutes: 45, targetMinutes: 75 });
    const replay = await api(path, body); expect(await replay.json()).toEqual(original); expect(replay.headers.get('cache-control')).toContain('no-store');
    expect((await api(path, { ...body, additionalMinutes: 15 })).status).toBe(409);
    expect((await api(path, body, localIdentityCookie().cookie)).status).toBe(404);
    expect((await api(path, body, null)).status).toBe(401);
    expect((await api(path, { ...body, requestId: randomUUID(), expectedRevision: original.session.revision, additionalMinutes: 1 })).status).toBe(400);
    expect((await api(path, { ...body, requestId: randomUUID(), reason: 'private health detail' })).status).toBe(400);
  });
});
