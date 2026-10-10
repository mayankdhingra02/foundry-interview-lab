import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEARNER_CHECK_POLICY as policy } from '../lib/interview-practice/check-policy';
import { getScenario } from '../lib/content/scenarios';
import { localIdentityCookie } from '../lib/server/auth';
import { practiceApi } from '../lib/server/practice-api';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';

let service: SessionService, cookie: string, owner: string;
vi.mock('../lib/server/application',() => ({ getService: () => Promise.resolve(service) }));
vi.mock('../lib/server/worker',() => ({ kickLocalWorker: vi.fn() }));
beforeEach(() => {
  vi.stubEnv('NODE_ENV','test'); vi.stubEnv('AUTH_MODE','local'); vi.stubEnv('SESSION_SECRET','c'.repeat(32)); vi.stubEnv('APP_URL','http://127.0.0.1:3000'); vi.stubEnv('FEATURE_EXECUTION','true');
  const identity = localIdentityCookie(); cookie = identity.cookie; owner = identity.actor.id;
  service = new SessionService(new MemoryPracticeStore(),getScenario);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function api(path: string,method: string,value?: unknown,identity = cookie) {
  return practiceApi(new Request(`http://127.0.0.1:3000/api/interview-practice/${path}`,{ method,headers: { cookie: identity,origin: 'http://127.0.0.1:3000',...(value === undefined ? {} : { 'content-type': 'application/json' }) },...(value === undefined ? {} : { body: JSON.stringify(value) }) }),path.split('/'));
}
async function withCheck() {
  const session = (await service.createSession(owner,{ scenarioId: 'monetary-validation',requestId: randomUUID() })).session;
  const response = await api(`sessions/${session.id}/workspace`,'PUT',{ requestId: randomUUID(),expectedRevision: session.revision,files: { ...session.files,[policy.path]: 'import unittest\nclass Check(unittest.TestCase):\n    def test_sum(self): self.assertEqual(1 + 1, 2)\n' } });
  expect(response.status).toBe(200); return (await response.json()).session;
}
describe('explicit learner check HTTP admission',() => {
  it('preserves explicit selection, replays the same job, and rejects same-key suite changes',async () => {
    const session = await withCheck(), body = { requestId: randomUUID(),expectedRevision: session.revision,selection: 'learner' };
    const first = await api(`sessions/${session.id}/runs`,'POST',body); expect(first.status).toBe(202);
    const job = (await first.json()).job;
    const stored = await service.exportSession(owner,session.id);
    expect(stored.jobs[0].input).toMatchObject({ selection: 'learner',learnerCheck: { workspacePolicyVersion: 1,executionPolicyVersion: 1 } });
    expect((await (await api(`sessions/${session.id}/runs`,'POST',body)).json()).job.id).toBe(job.id);
    expect((await api(`sessions/${session.id}/runs`,'POST',{ ...body,selection: 'authored' })).status).toBe(409);
  });
  it('rejects arbitrary selection/source/policy injection and cross-owner writes',async () => {
    const session = await withCheck(), base = { requestId: randomUUID(),expectedRevision: session.revision };
    for (const fields of [{ selection: 'shell' },{ selection: 'learner',source: 'fake replacement' },{ selection: 'learner',learnerCheck: { executionPolicyVersion: 999 } }]) expect((await api(`sessions/${session.id}/runs`,'POST',{ ...base,...fields })).status).toBe(400);
    expect((await api(`sessions/${session.id}/runs`,'POST',{ ...base,selection: 'learner' },localIdentityCookie().cookie)).status).toBe(404);
    expect((await service.exportSession(owner,session.id)).jobs).toHaveLength(0);
  });
  it('does not expose protected source through workspace or run DTOs',async () => {
    const session = await withCheck();
    const first = await api(`sessions/${session.id}/runs`,'POST',{ requestId: randomUUID(),expectedRevision: session.revision,selection: 'learner' });
    const data = await first.json();
    expect(data.session.files[policy.path]).toContain('unittest'); expect(data.job.input).toBeUndefined();
    for (const test of getScenario('monetary-validation')!.tests.filter(test => !test.visible)) expect(JSON.stringify(data)).not.toContain(test.source);
    expect(data.session.scenario.referenceFiles).toBeUndefined();
  });
});
