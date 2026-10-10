import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { localIdentityCookie } from '../lib/server/auth';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { telemetryApi } from '../lib/server/telemetry-api';
import { practiceApi } from '../lib/server/practice-api';
let service: SessionService, identity: ReturnType<typeof localIdentityCookie>, id: string, reportId: string;
vi.mock('../lib/server/application', () => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker', () => ({ kickLocalWorker: vi.fn() }));
function request(body: unknown, cookie = identity.cookie, origin = 'http://127.0.0.1:3000') {
  return new Request(`http://127.0.0.1:3000/api/interview-practice/sessions/${id}/observations`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 's'.repeat(32)); vi.stubEnv('APP_URL', 'http://127.0.0.1:3000');
  vi.stubEnv('FEATURE_PRACTICE_TELEMETRY', 'true'); vi.stubEnv('PRACTICE_TELEMETRY_SINK', 'stdout'); vi.stubEnv('PRACTICE_TELEMETRY_SECRET', 't'.repeat(32));
  identity = localIdentityCookie(); service = new SessionService(new MemoryPracticeStore(), getScenario);
  id = (await service.createSession(identity.actor.id, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session.id;
  reportId = randomUUID();
  await service.store.transaction(db => { db.sessions[id].reports.push({ id: reportId, generationId: randomUUID(), createdAt: new Date().toISOString(), model: 'authored-observation-only', promptVersion: 'synthetic-unit-fixture', rubricVersion: '1.0.0', evidenceDigest: 'a'.repeat(64), evidence: [], overview: 'Synthetic route fixture only.', rubric: [], nextPractice: [] }); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('authenticated nonauthoritative observation ingress', () => {
  it('accepts owned report observations without changing session events, revisions or evidence', async () => {
    const before = await service.store.read(), log = vi.spyOn(console, 'info').mockImplementation(() => {}), body = { event: 'feedback.opened', eventId: randomUUID(), reportId };
    expect((await telemetryApi(request(body), id)).status).toBe(202);
    expect((await (await telemetryApi(request(body), id)).json()).duplicate).toBe(true);
    expect(log).toHaveBeenCalledTimes(1); const record = JSON.parse(log.mock.calls[0][0]);
    expect(record).toMatchObject({ event: 'feedback.opened', reportKind: 'original', origin: 'browser-unverified' });
    expect(JSON.stringify(record)).not.toContain(reportId); expect(JSON.stringify(record)).not.toContain(id);
    expect(await service.store.read()).toEqual(before);
  });
  it('applies ownership, same-origin, report identity, strict shape and streamed size bounds', async () => {
    const body = { event: 'feedback.opened', eventId: randomUUID(), reportId };
    expect((await telemetryApi(request(body, ''), id)).status).toBe(401);
    expect((await telemetryApi(request(body, localIdentityCookie().cookie), id)).status).toBe(404);
    expect((await telemetryApi(request(body, identity.cookie, 'https://different.invalid'), id)).status).toBe(403);
    expect((await telemetryApi(request({ ...body, reportId: randomUUID() }), id)).status).toBe(404);
    expect((await telemetryApi(request({ ...body, transcript: 'PRIVATE' }), id)).status).toBe(400);
    expect((await telemetryApi(request({ ...body, code: 'x'.repeat(1_000) }), id)).status).toBe(413);
  });
  it('does not accept forged product facts, server-only metrics, or unrelated job correlation', async () => {
    const body = { event: 'latency.measured', eventId: randomUUID(), metric: 'run.result', durationMs: 30, outcome: 'acknowledged' };
    expect((await telemetryApi(request({ ...body, event: 'unseen-retest.completed' }), id)).status).toBe(400);
    expect((await telemetryApi(request({ ...body, metric: 'sandbox.provision' }), id)).status).toBe(400);
    expect((await telemetryApi(request({ ...body, jobId: randomUUID() }), id)).status).toBe(404);
    const job = await service.requestRun(identity.actor.id, id, { requestId: randomUUID(), expectedRevision: (await service.getSession(identity.actor.id, id)).revision });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect((await telemetryApi(request({ ...body, jobId: job.job!.id }), id)).status).toBe(202);
    expect(JSON.parse(log.mock.calls[0][0]).origin).toBe('browser-unverified');
    expect((await telemetryApi(request({ ...body, eventId: randomUUID(), metric: 'report.ready', jobId: job.job!.id }), id)).status).toBe(404);
  });
  it('keeps disabled sinks silent and a throwing diagnostic sink cannot fail an acknowledged save', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('collector outage'); });
    const session = await service.getSession(identity.actor.id, id);
    const save = new Request(`http://127.0.0.1:3000/api/interview-practice/sessions/${id}/workspace`, { method: 'PUT', headers: { cookie: identity.cookie, origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' }, body: JSON.stringify({ requestId: randomUUID(), expectedRevision: session.revision, files: session.files }) });
    expect((await practiceApi(save, ['sessions', id, 'workspace'])).status).toBe(200);
    vi.stubEnv('FEATURE_PRACTICE_TELEMETRY', 'false'); log.mockClear();
    expect((await telemetryApi(request({ event: 'feedback.opened', eventId: randomUUID(), reportId }), id)).status).toBe(204); expect(log).not.toHaveBeenCalled();
  });
});
