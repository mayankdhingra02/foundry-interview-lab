import { completeFixtureJob } from './inference-fixtures';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { practiceApi } from '../lib/server/practice-api';
import { localIdentityCookie } from '../lib/server/auth';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { getScenario } from '../lib/content/scenarios';

let service: SessionService;
vi.mock('../lib/server/application', () => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker', () => ({ kickLocalWorker: vi.fn() }));
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'b'.repeat(32)); vi.stubEnv('APP_URL', 'http://127.0.0.1:3000');
  service = new SessionService(new MemoryPracticeStore(), getScenario);
});
afterEach(() => vi.unstubAllEnvs());

describe('accepted edit undo HTTP boundary', () => {
  it('requires owner identity and same-origin strict input, then replays the original restored result', async () => {
    const identity = localIdentityCookie(), owner = identity.actor.id;
    let session = (await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
    await service.requestAssistant(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, mode: 'edit', message: 'Synthetic HTTP edit' });
    await completeFixtureJob(service, (await service.claimJob('api-undo-fixture'))!, { kind: 'assistant', files: { 'quote.py': '# HTTP proposal' }, message: 'Synthetic', model: 'fixture', actualUsd: 0 });
    session = await service.getSession(owner, session.id); const proposalId = session.editProposals[0].id;
    session = (await service.decideEdit(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, proposalId, decision: 'accept' })).session;
    const input = { requestId: randomUUID(), expectedRevision: session.revision, proposalId }, path = ['sessions', session.id, 'undo-edit'];
    const api = (body: unknown, cookie: string | null = identity.cookie, origin = 'http://127.0.0.1:3000') => practiceApi(new Request(`http://127.0.0.1:3000/api/interview-practice/${path.join('/')}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), path);
    expect((await api(input, null)).status).toBe(401);
    expect((await api(input, localIdentityCookie().cookie)).status).toBe(404);
    expect((await api(input, identity.cookie, 'https://other.example')).status).toBe(403);
    expect((await api({ ...input, proposalId: 'invalid' })).status).toBe(400);
    expect((await api({ ...input, files: { 'quote.py': 'untrusted' } })).status).toBe(400);
    expect((await service.getSession(owner, session.id)).editProposals[0].undoneAt).toBeUndefined();
    const first = await api(input); expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toContain('no-store');
    const result = await first.json(); expect(result.session.editProposals[0].undoneAt).toBeDefined();
    const replay = await api(input); expect(replay.status).toBe(200); expect((await replay.json()).session).toEqual(result.session);
  });
});
