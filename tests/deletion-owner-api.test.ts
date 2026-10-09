import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE as deleteAccount } from '../app/api/account/route';
import { practiceApi } from '../lib/server/practice-api';
import { getScenario } from '../lib/content/scenarios';
import { localIdentityCookie } from '../lib/server/auth';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';

let service: SessionService;
vi.mock('../lib/server/application', () => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker', () => ({ kickLocalWorker: vi.fn() }));
let first: ReturnType<typeof localIdentityCookie>, second: ReturnType<typeof localIdentityCookie>;
let number = 0;
const key = () => `delete-owner-request-${++number}`;
function request(path: string, cookie: string, intendedOwner?: string, requestId = key()) {
  return new Request(`http://127.0.0.1:3000/api/${path}`, { method: 'DELETE', headers: { origin: 'http://127.0.0.1:3000', cookie, 'content-type': 'application/json', ...(intendedOwner === undefined ? {} : { 'X-Practice-Owner': intendedOwner }) }, body: JSON.stringify({ requestId, confirmation: 'DELETE' }) });
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'b'.repeat(32)); vi.stubEnv('APP_URL', 'http://127.0.0.1:3000');
  first = localIdentityCookie(); second = localIdentityCookie(); service = new SessionService(new MemoryPracticeStore(), getScenario);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function saved(owner: string) { return (await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: key() })).session; }

describe('intended owner binding on destructive HTTP requests', () => {
  it('binds the pre-deletion owned history to the intended owner without breaking legacy reads', async () => {
    await saved(first.actor.id); await saved(second.actor.id);
    const read = (cookie: string, intendedOwner?: string) => practiceApi(new Request('http://127.0.0.1:3000/api/interview-practice/sessions', { headers: { cookie, ...(intendedOwner === undefined ? {} : { 'X-Practice-Owner': intendedOwner }) } }), ['sessions']);
    const switched = await read(second.cookie, first.actor.id); expect(switched.status).toBe(409); expect((await switched.json()).error.code).toBe('owner_changed');
    expect((await (await read(first.cookie, first.actor.id)).json()).sessions).toHaveLength(1);
    expect((await read(second.cookie)).status).toBe(200);
  });
  it('rejects an account switch between client identity check and DELETE before calling the deletion service', async () => {
    await saved(first.actor.id); await saved(second.actor.id); const mutation = vi.spyOn(service, 'deleteAccount');
    const response = await deleteAccount(request('account', second.cookie, first.actor.id));
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('owner_changed'); expect(mutation).not.toHaveBeenCalled();
    expect(await service.listSessions(first.actor.id)).toHaveLength(1); expect(await service.listSessions(second.actor.id)).toHaveLength(1);
  });
  it('replays a matching account deletion key only for the intended authenticated owner', async () => {
    await saved(first.actor.id); await saved(second.actor.id); const requestId = key();
    expect((await deleteAccount(request('account', first.cookie, first.actor.id, requestId))).status).toBe(200);
    const switched = await deleteAccount(request('account', second.cookie, first.actor.id, requestId)); expect(switched.status).toBe(409);
    const replay = await deleteAccount(request('account', first.cookie, first.actor.id, requestId)); expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ deleted: true });
    expect(await service.listSessions(first.actor.id)).toHaveLength(0); expect(await service.listSessions(second.actor.id)).toHaveLength(1);
  });
  it('rejects a switched session DELETE before service dispatch even if the new account owns the targeted session', async () => {
    const session = await saved(second.actor.id), mutation = vi.spyOn(service, 'deleteSession');
    const response = await practiceApi(request(`interview-practice/sessions/${session.id}`, second.cookie, first.actor.id), ['sessions', session.id]);
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('owner_changed'); expect(mutation).not.toHaveBeenCalled(); expect(await service.listSessions(second.actor.id)).toHaveLength(1);
  });
  it('accepts matching session owner binding, preserves ordinary ownership checks and exact retry replay', async () => {
    const session = await saved(first.actor.id), requestId = key();
    const foreign = await practiceApi(request(`interview-practice/sessions/${session.id}`, second.cookie, second.actor.id), ['sessions', session.id]); expect(foreign.status).toBe(404);
    const perform = () => practiceApi(request(`interview-practice/sessions/${session.id}`, first.cookie, first.actor.id, requestId), ['sessions', session.id]);
    expect((await perform()).status).toBe(200); const replay = await perform(); expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ deleted: true });
  });
  it('keeps legacy clients without the optional header authorized by their authenticated owner', async () => {
    const session = await saved(first.actor.id);
    expect((await practiceApi(request(`interview-practice/sessions/${session.id}`, first.cookie), ['sessions', session.id])).status).toBe(200);
    await saved(first.actor.id); expect((await deleteAccount(request('account', first.cookie))).status).toBe(200); expect(await service.listSessions(first.actor.id)).toEqual([]);
  });
  it('treats an explicitly empty intended-owner header as a mismatch rather than legacy absence', async () => {
    await saved(first.actor.id); const response = await deleteAccount(request('account', first.cookie, '')); expect(response.status).toBe(409); expect(await service.listSessions(first.actor.id)).toHaveLength(1);
  });
});
