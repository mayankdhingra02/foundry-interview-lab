import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPracticeApi, type PracticeApiHost, type VerifiedPracticeActor } from '../lib/server/practice-dispatcher';
import { HttpError, privateJson } from '../lib/server/http-core';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { getScenario } from '../lib/content/scenarios';
import { InteractionService } from '../lib/server/interactions';
import { fixtureRuntimeBinding } from './runtime-fixtures';

// A host dispatcher must not load the standalone identity, application, worker,
// config or extension composition, even transitively. These factories throw if loaded.
vi.mock('../lib/server/auth', () => { throw new Error('Standalone auth loaded by host core'); });
vi.mock('../lib/server/application', () => { throw new Error('Standalone application loaded by host core'); });
vi.mock('../lib/server/worker', () => { throw new Error('Local worker loaded by host core'); });
vi.mock('../lib/server/config', () => { throw new Error('Standalone configuration loaded by host core'); });
vi.mock('../lib/server/review-api', () => { throw new Error('Standalone review auth loaded by host core'); });
vi.mock('../lib/voice/api', () => { throw new Error('Standalone voice composition loaded by host core'); });

const origin = 'https://engineeringfoundry.example';
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
let actor: VerifiedPracticeActor | null;
let service: SessionService, store: MemoryPracticeStore, host: PracticeApiHost;
let api: ReturnType<typeof createPracticeApi>, sequence = 0;
const requestId = () => `host-request-${++sequence}`;
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return api(new Request(`${origin}/api/interview-practice/${path}`, {
    method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('?')[0].split('/'));
}
async function create(input: Record<string, unknown> = {}) {
  const response = await request('sessions', 'POST', { requestId: requestId(), scenarioId: 'monetary-validation', ...input });
  expect(response.status).toBe(201); return (await response.json()).session;
}
beforeEach(() => {
  actor = { id: owner }; store = new MemoryPracticeStore();
  service = new SessionService(store, getScenario, { inferenceBinding: () => null, runtimeBinding: fixtureRuntimeBinding });
  host = {
    resolveActor: vi.fn(async () => actor), getService: vi.fn(async () => service),
    origin: () => origin,
    capabilities: () => ({ ai: false, coaching: false, interviewer: false, assistant: false, runner: true, voice: false, billing: false, accounts: true }),
    listScenarios: () => [getScenario('monetary-validation')!], admittedScenarios: catalog => catalog,
    withNavigation: result => result, executionAdmissionOpen: vi.fn(async () => true), notifyWorkAvailable: vi.fn(),
    interact: (service, ownerId, sessionId, input) => new InteractionService(service.store).interact(ownerId, sessionId, input),
    ownerReviews: vi.fn(async (_request, ownerId, sessionId) => { await service.getSession(ownerId, sessionId); return privateJson({ cases: [] }); }),
    ownerReviewConsent: vi.fn(async () => privateJson({ case: null })),
    exportReviews: vi.fn(async () => ({ cases: [], drafts: [], decisions: [], publications: [], audit: [] })),
    handleVoiceRequest: vi.fn(async () => { throw new HttpError(503, 'voice_unavailable', 'Voice is unavailable.'); }),
    emitMutationTelemetry: vi.fn(), emitTelemetry: vi.fn(),
  };
  api = createPracticeApi(host);
});
afterEach(() => vi.restoreAllMocks());

describe('verified host practice dispatcher', () => {
  it('serves sanitized public catalog/capabilities without resolving identity or storage', async () => {
    actor = null;
    const catalog = await request('scenarios'), body = await catalog.json();
    expect(catalog.status).toBe(200); expect(body.scenarios).toHaveLength(1);
    expect(body.scenarios[0]).not.toHaveProperty('referenceFiles'); expect(body.scenarios[0]).not.toHaveProperty('probes');
    expect(body.scenarios[0].tests.filter((test: { visible: boolean }) => !test.visible).every((test: { source?: string }) => test.source === undefined)).toBe(true);
    expect((await request('capabilities')).status).toBe(200);
    expect(host.resolveActor).not.toHaveBeenCalled(); expect(host.getService).not.toHaveBeenCalled();
    expect(catalog.headers.get('cache-control')).toBe('private, no-store');
  });
  it('distinguishes a verified missing session from an unavailable identity provider', async () => {
    actor = null; const anonymous = await request('sessions');
    expect(anonymous.status).toBe(401); expect((await anonymous.json()).error.code).toBe('authentication_required');
    host.resolveActor = async () => { throw new HttpError(503, 'identity_unconfigured', 'Verified account access is unavailable.'); };
    const unavailable = await request('sessions');
    expect(unavailable.status).toBe(503); expect((await unavailable.json()).error.code).toBe('identity_unconfigured');
    expect(host.getService).not.toHaveBeenCalled();
  });
  it('fails malformed host identities closed rather than manufacturing a local identity', async () => {
    actor = { id: '' }; expect((await request('sessions')).status).toBe(503);
    expect(host.getService).not.toHaveBeenCalled(); expect(await service.listSessions(owner)).toEqual([]);
  });
  it('uses only host-verified ownership despite forged cookie/body/header identity', async () => {
    const session = await create({ ownerId: other });
    expect(await service.listSessions(other)).toEqual([]);
    expect((await service.listSessions(owner))[0].id).toBe(session.id);
    actor = { id: other };
    expect((await request(`sessions/${session.id}`, 'GET', undefined, { cookie: `foundry_local_actor=${owner}`, 'x-practice-owner': owner })).status).toBe(404);
    expect((await request(`sessions/${session.id}/export`)).status).toBe(404);
    expect((await request(`sessions/${session.id}/workspace`, 'PUT', { requestId: requestId(), expectedRevision: session.revision, files: session.files, ownerId: owner })).status).toBe(404);
    expect((await request('sessions', 'GET', undefined, { 'x-practice-owner': owner })).status).toBe(409);
  });
  it('retains real creation replay, request-conflict and optimistic workspace semantics', async () => {
    const key = requestId(), original = await create({ requestId: key });
    const replay = await create({ requestId: key }); expect(replay.id).toBe(original.id);
    expect((await request('sessions', 'POST', { requestId: key, scenarioId: 'extension-compatibility' })).status).toBe(409);
    const saved = { requestId: requestId(), expectedRevision: original.revision, files: { ...original.files, 'quote.py': '# acknowledged\n' } };
    const first = await request(`sessions/${original.id}/workspace`, 'PUT', saved);
    expect(first.status).toBe(200); const committed = (await first.json()).session;
    const again = await request(`sessions/${original.id}/workspace`, 'PUT', saved);
    expect(again.status).toBe(200); expect((await again.json()).session.revision).toBe(committed.revision);
    expect((await request(`sessions/${original.id}/workspace`, 'PUT', { ...saved, requestId: requestId() })).status).toBe(409);
    expect((await service.getSession(owner, original.id)).files['quote.py']).toBe('# acknowledged\n');
  });
  it.each(['https://evil.example', 'null', ''])('rejects untrusted or missing Origin %j before authentication or writes', async supplied => {
    const response = await request('sessions', 'POST', { requestId: requestId(), scenarioId: 'monetary-validation' }, { origin: supplied, host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' });
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe('origin_denied');
    expect(host.resolveActor).not.toHaveBeenCalled(); expect(host.getService).not.toHaveBeenCalled();
  });
  it('takes mutation origin only from the configured host and denies noncanonical configuration', async () => {
    host.origin = () => 'https://engineeringfoundry.example/path';
    expect((await request('sessions', 'POST', { requestId: requestId(), scenarioId: 'monetary-validation' })).status).toBe(503);
    expect(host.resolveActor).not.toHaveBeenCalled();
    // Reads preserve existing semantics and do not depend on mutation-origin configuration.
    expect((await request('capabilities')).status).toBe(200);
  });
  it('notifies only after a successful commit and cannot turn notifier failure into a lost mutation response', async () => {
    const session = await create(); expect(host.notifyWorkAvailable).not.toHaveBeenCalled(); // Standalone creation notification behavior is preserved.
    let observedWorkspace: string | undefined;
    host.notifyWorkAvailable = vi.fn(async () => {
      observedWorkspace = (await service.getSession(owner, session.id)).files['quote.py'];
      throw new Error('Synthetic host queue-notification outage');
    });
    const save = { requestId: requestId(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# committed before notification\n' } };
    const result = await request(`sessions/${session.id}/workspace`, 'PUT', save);
    expect(result.status).toBe(200); expect(host.notifyWorkAvailable).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(observedWorkspace).toBe('# committed before notification\n'));
    expect((await request(`sessions/${session.id}/workspace`, 'PUT', { ...save, requestId: requestId() })).status).toBe(409);
    expect(host.notifyWorkAvailable).toHaveBeenCalledTimes(1);
    expect((await request(`sessions/${session.id}/workspace`, 'PUT', save)).status).toBe(200);
    expect(host.notifyWorkAvailable).toHaveBeenCalledTimes(2); // Reconciliation signals may be repeated; work is not duplicated.
    expect((await service.exportSession(owner, session.id)).snapshots).toHaveLength(2);
  });
  it('returns acknowledged work even when an async notification never settles', async () => {
    const session = await create(); host.notifyWorkAvailable = () => new Promise<void>(() => {});
    const response = await request(`sessions/${session.id}/workspace`, 'PUT', { requestId: requestId(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# retained without notification\n' } });
    expect(response.status).toBe(200);
    expect((await service.getSession(owner, session.id)).files['quote.py']).toBe('# retained without notification\n');
  });
  it('rejects missing Origin without consulting even unavailable origin configuration', async () => {
    host.origin = vi.fn(() => { throw new Error('Synthetic missing configuration'); });
    expect((await request('sessions', 'POST', { requestId: requestId(), scenarioId: 'monetary-validation' }, { origin: '' })).status).toBe(403);
    expect(host.origin).not.toHaveBeenCalled(); expect(host.resolveActor).not.toHaveBeenCalled();
  });
  it('uses the host interaction policy and clock rather than ambient defaults', async () => {
    const session = await create(); const now = () => new Date('2030-01-01T12:00:00.000Z');
    const interactions = new InteractionService(store, now, { ownerMutationsPerMinute: 1 });
    host.interact = vi.fn((_service, ownerId, sessionId, input) => interactions.interact(ownerId, sessionId, input));
    const body = { requestId: requestId(), expectedRevision: session.revision, action: 'working' };
    const first = await request(`sessions/${session.id}/interaction`, 'POST', body);
    expect(first.status).toBe(200); const committed = (await first.json()).session;
    expect(committed.events.at(-1).occurredAt).toBe(now().toISOString());
    expect((await request(`sessions/${session.id}/interaction`, 'POST', { ...body, requestId: requestId(), expectedRevision: committed.revision })).status).toBe(429);
    expect((await request(`sessions/${session.id}/interaction`, 'POST', body)).status).toBe(200);
    expect(host.interact).toHaveBeenCalledWith(service, owner, session.id, expect.objectContaining({ action: 'working' }));
  });
  it('keeps optional throwing or rejected telemetry collectors from invalidating acknowledged work', async () => {
    host.emitMutationTelemetry = () => { throw new Error('Synthetic collector failure'); };
    const session = await create();
    host.emitTelemetry = () => Promise.reject(new Error('Synthetic async collector failure'));
    expect((await request(`sessions/${session.id}/workspace`, 'PUT', { requestId: requestId(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# retained despite collector failure\n' } })).status).toBe(200);
    expect((await service.getSession(owner, session.id)).files['quote.py']).toBe('# retained despite collector failure\n');
  });
  it('checks current run readiness only for fresh admitted work, retaining acknowledged replay', async () => {
    const session = await create();
    const body = { requestId: requestId(), expectedRevision: session.revision };
    const run = await request(`sessions/${session.id}/runs`, 'POST', body);
    expect(run.status).toBe(202); const admitted = await run.json();
    host.executionAdmissionOpen = async () => false;
    const replay = await request(`sessions/${session.id}/runs`, 'POST', body);
    expect(replay.status).toBe(202); expect((await replay.json()).job.id).toBe(admitted.job.id);
    expect((await request(`sessions/${session.id}/runs`, 'POST', { ...body, requestId: requestId(), expectedRevision: admitted.session.revision })).status).toBe(503);
    actor = { id: other };
    expect((await request(`sessions/${session.id}/runs`, 'POST', { ...body, requestId: requestId() })).status).toBe(404);
  });
  it('keeps assistance disabled independently of host identity and rejects forged strict control fields', async () => {
    const session = await create();
    const response = await request(`sessions/${session.id}/assistant`, 'POST', { requestId: requestId(), expectedRevision: session.revision, mode: 'ask', message: 'Review this implementation.' });
    expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('assistant_unavailable');
    expect((await service.getSession(owner, session.id)).jobs).toEqual([]);
    expect((await request(`sessions/${session.id}/runs`, 'POST', { requestId: requestId(), expectedRevision: session.revision, ownerId: other })).status).toBe(400);
    expect(host.notifyWorkAvailable).not.toHaveBeenCalled();
  });
  it('exports real owner snapshots with explicit review export and never invokes it for a foreign owner', async () => {
    const session = await create();
    const response = await request(`sessions/${session.id}/export`), exported = await response.json();
    expect(response.status).toBe(200); expect(exported.session.snapshots).toHaveLength(1);
    expect(exported.session).not.toHaveProperty('ownerId'); expect(exported.reviews.cases).toEqual([]);
    expect(host.exportReviews).toHaveBeenCalledWith(owner, session.id);
    actor = { id: other };
    expect((await request(`sessions/${session.id}/export`)).status).toBe(404);
    expect(host.exportReviews).toHaveBeenCalledTimes(1);
  });
  it('passes only the verified owner into explicit review/voice delegates after CSRF and authentication', async () => {
    const session = await create();
    expect((await request(`sessions/${session.id}/reviews`, 'GET')).status).toBe(200);
    expect(host.ownerReviews).toHaveBeenCalledWith(expect.any(Request), owner, session.id);
    expect((await request(`sessions/${session.id}/voice/speak`, 'POST', { consent: true })).status).toBe(503);
    expect(host.handleVoiceRequest).toHaveBeenCalledWith(expect.any(Request), owner, session.id, 'speak');
    actor = null;
    expect((await request(`sessions/${session.id}/reviews`, 'POST', {})).status).toBe(401);
    expect(host.ownerReviews).toHaveBeenCalledTimes(1);
  });
});
