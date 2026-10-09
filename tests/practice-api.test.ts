import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { practiceApi } from '../lib/server/practice-api';
import { getScenario } from '../lib/content/scenarios';
import { localIdentityCookie } from '../lib/server/auth';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { exportPracticeSession } from '../lib/server/export';

let service: SessionService;
vi.mock('../lib/server/application', () => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker', () => ({ kickLocalWorker: vi.fn() }));
let cookie: string, ownerId: string;
let number = 0;
const requestId = () => `api-request-${++number}`;
async function api(path: string, method = 'GET', value?: unknown, headers: Record<string,string> = {}, identity: string | null = cookie) {
  return practiceApi(new Request(`http://127.0.0.1:3000/api/interview-practice/${path}`, { method, headers: { origin: 'http://127.0.0.1:3000', ...(identity ? { cookie: identity } : {}), ...(value === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }), path.split('?')[0].split('/'));
}
async function create() {
  const response = await api('sessions', 'POST', { requestId: requestId(), scenarioId: 'monetary-validation' });
  expect(response.status).toBe(201); return (await response.json()).session;
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'b'.repeat(32)); vi.stubEnv('APP_URL', 'http://127.0.0.1:3000'); vi.stubEnv('OPENAI_API_KEY', '');
  const identity = localIdentityCookie(); cookie = identity.cookie; ownerId = identity.actor.id;
  service = new SessionService(new MemoryPracticeStore(), getScenario);
});
afterEach(() => vi.unstubAllEnvs());

describe('authenticated practice HTTP contracts', () => {
  it('serves a catalog without leaking protected tests, probes or reference solutions', async () => {
    const response = await api('scenarios', 'GET', undefined, {}, null), data = await response.json();
    expect(data.scenarios).toHaveLength(5);
    for (const scenario of data.scenarios) {
      expect(scenario.referenceFiles).toBeUndefined(); expect(scenario.probes).toBeUndefined(); expect(scenario.hints).toBeUndefined();
      expect(scenario.tests.filter((t: {visible: boolean}) => !t.visible).every((t: {source?: string}) => t.source === undefined)).toBe(true);
    }
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects anonymous sessions and another signed owner', async () => {
    expect((await api('sessions', 'GET', undefined, {}, null)).status).toBe(401);
    const session = await create(), other = localIdentityCookie().cookie;
    expect((await api(`sessions/${session.id}`, 'GET', undefined, {}, other)).status).toBe(404);
    expect((await api(`sessions/${session.id}/export`, 'GET', undefined, {}, other)).status).toBe(404);
  });
  it('preserves duplicate request replay and rejects revision conflicts and cross-origin writes', async () => {
    const body = { requestId: requestId(), scenarioId: 'monetary-validation' };
    const first = await (await api('sessions', 'POST', body)).json(), replay = await (await api('sessions', 'POST', body)).json();
    expect(replay.session.id).toBe(first.session.id);
    const files = { ...first.session.files, 'quote.py': '# saved\n' };
    const save = { requestId: requestId(), expectedRevision: first.session.revision, files };
    expect((await api(`sessions/${first.session.id}/workspace`, 'PUT', save)).status).toBe(200);
    expect((await api(`sessions/${first.session.id}/workspace`, 'PUT', { ...save, requestId: requestId() })).status).toBe(409);
    expect((await api('sessions', 'POST', body, { origin: 'https://evil.example' })).status).toBe(403);
  });
  it('exports all acknowledged snapshots and excludes worker claim credentials', async () => {
    const session = await create(); await api(`sessions/${session.id}/workspace`, 'PUT', { requestId: requestId(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# saved\n' } });
    const response = await api(`sessions/${session.id}/export`), data = await response.json();
    expect(data.session.snapshots).toHaveLength(2); expect(data.session.snapshots[1].files['quote.py']).toBe('# saved\n');
    const privateSession = await service.exportSession(ownerId, session.id);
    expect(exportPracticeSession(privateSession)).not.toHaveProperty('ownerId');
    expect(JSON.stringify(data)).not.toContain('claimToken');
  });
  it('routes owner support permission changes and includes only that attempt in its export', async () => {
    const session = await create(), other = localIdentityCookie().cookie;
    const response = await api(`sessions/${session.id}/reviews`, 'POST', { requestId: requestId(), category: 'technical', message: 'My saved test result was interrupted.', inspectionConsent: false, supportActionsConsent: false });
    expect(response.status).toBe(201); const created = (await response.json()).case;
    expect((await api(`sessions/${session.id}/reviews`, 'GET', undefined, {}, other)).status).toBe(404);
    expect((await api(`reviews/${created.id}/consent`, 'POST', { requestId: requestId(), expectedRevision: 1, inspectionConsent: true, supportActionsConsent: false }, {}, other)).status).toBe(404);
    const consent = await api(`reviews/${created.id}/consent`, 'POST', { requestId: requestId(), expectedRevision: 1, inspectionConsent: true, supportActionsConsent: false });
    expect(consent.status).toBe(200);
    const exported = await (await api(`sessions/${session.id}/export`)).json();
    expect(exported.reviews.cases).toHaveLength(1); expect(exported.reviews.cases[0].id).toBe(created.id);
    expect(exported.reviews.cases[0].inspectionConsent).toBe(true);
    const second = await create();
    expect((await (await api(`sessions/${second.id}/export`)).json()).reviews.cases).toEqual([]);
    await api(`sessions/${session.id}`, 'DELETE', { requestId: requestId() });
    expect((await api(`reviews/${created.id}/consent`, 'POST', { requestId: requestId(), expectedRevision: 2, inspectionConsent: false, supportActionsConsent: false })).status).toBe(404);
  });
  it('routes bounded owner interview controls without admitting inference or an answer', async () => {
    const session = await create();
    const body = { requestId: requestId(), expectedRevision: session.revision, action: 'clarify', topic: 'assistance' };
    const response = await api(`sessions/${session.id}/interaction`, 'POST', body);
    expect(response.status).toBe(200); const result = await response.json();
    expect(result.response).toContain('coding assistant'); expect(result.session.jobs).toEqual([]); expect(result.session.turns).toEqual([]);
    expect((await api(`sessions/${session.id}/interaction`, 'POST', body, {}, localIdentityCookie().cookie)).status).toBe(404);
    expect((await api(`sessions/${session.id}/interaction`, 'POST', { ...body, requestId: requestId(), ownerId: 'forged' })).status).toBe(400);
  });
  it('returns an owner-only provisional plan and validates bounded authored goal IDs', async () => {
    const response = await api('progress?competency=money-validation&competency=money-correctness&competency=money-validation');
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    const plan = await response.json();
    expect(plan.studyPlan.status).toBe('cold-start');
    expect(plan.studyPlan.selectedCompetencies).toEqual(['money-correctness', 'money-validation']);
    expect(plan.studyPlan.steps.length).toBeLessThanOrEqual(3); expect(plan.details.attempts).toBe(0);
    expect((await api('progress?competency=verification')).status).toBe(400); // Internal transfer aliases are not public criteria.
    expect((await api(`progress?${Array.from({ length: 21 }, () => 'competency=money-validation').join('&')}`)).status).toBe(400);
    expect((await api('progress?competency=')).status).toBe(400);
    expect((await api('progress', 'GET', undefined, {}, null)).status).toBe(401);
  });
  it('allows a saved retired criterion only for the owner whose attempt defines it', async () => {
    const retired = (id: string, criterion: string) => {
      const scenario = structuredClone(getScenario('monetary-validation')!);
      scenario.id = id; scenario.rubric[0].id = criterion; return scenario;
    };
    const owned = retired('retired-owner-task', 'retired-owner-criterion'), other = retired('retired-other-task', 'retired-other-criterion');
    service = new SessionService(new MemoryPracticeStore(), id => id === owned.id ? owned : id === other.id ? other : getScenario(id));
    await service.createSession(ownerId, { scenarioId: owned.id, requestId: requestId() });
    await service.createSession(localIdentityCookie().actor.id, { scenarioId: other.id, requestId: requestId() });
    const response = await api('progress?competency=retired-owner-criterion'); expect(response.status).toBe(200);
    const plan = await response.json(); expect(plan.details.attempts).toBe(1);
    expect(plan.studyPlan.selectedCompetencies).toEqual(['retired-owner-criterion']);
    expect(plan.recommendations.some((item: { scenarioId: string }) => item.scenarioId.startsWith('retired-'))).toBe(false);
    expect((await api('progress?competency=retired-other-criterion')).status).toBe(400);
  });
  it('replays committed sequence IDs through SSE and closes on reader cancellation', async () => {
    const session = await create();
    const response = await api(`sessions/${session.id}/events`, 'GET', undefined, { accept: 'text/event-stream' });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader(), chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toContain('id: 1'); await reader.cancel();
    expect((await api(`sessions/${session.id}/events?after=-1`)).status).toBe(400);
  });
  it('deletes content and keeps owner history private', async () => {
    const session = await create();
    expect((await api(`sessions/${session.id}`, 'DELETE', { requestId: requestId() })).status).toBe(200);
    expect((await api(`sessions/${session.id}`)).status).toBe(404);
    expect((await (await api('sessions')).json()).sessions).toHaveLength(0);
  });
});
