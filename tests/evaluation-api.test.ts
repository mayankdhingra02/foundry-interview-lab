import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/server/http';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), service: vi.fn() }));
vi.mock('../lib/server/auth', () => ({ requireActor: mocks.actor }));
vi.mock('../lib/server/review-service', async original => ({ ...await original<typeof import('../lib/server/review-service')>(), getReviewService: mocks.service }));
import { internalReviewApi } from '../lib/server/review-api';

const staff = '11dc5c01-f748-46b7-b699-0b55f316a3c6';
const request = (path = '', method = 'GET') => new Request(`https://foundry.example/api/internal/evaluations${path}`, { method, headers: { origin: 'https://foundry.example' } });
describe('evaluation API exact staff access and fixed source boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APP_URL', 'https://foundry.example'); vi.stubEnv('ADMIN_USER_IDS', staff); mocks.actor.mockResolvedValue({ id: staff, local: false }); mocks.service.mockRejectedValue(new Error('PracticeStore must never be initialized for evaluation examples.')); });
  afterEach(() => vi.unstubAllEnvs());
  it('serves no-store list/detail without initializing practice, billing or support data', async () => {
    const response = await internalReviewApi(request(), ['evaluations']); expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = await response.json(); expect(result.examples).toHaveLength(21); expect(result.qualification.reviewedAttempts).toBe(0);
    const detail = await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference']); expect(detail.status).toBe(200); expect((await detail.json()).example.annotationStatus).toBe('pending');
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('denies anonymous, near-match IDs, ordinary learners and local production identities', async () => {
    mocks.actor.mockRejectedValueOnce(new HttpError(401, 'authentication_required', 'Sign in.')); expect((await internalReviewApi(request(), ['evaluations'])).status).toBe(401);
    for (const actor of [{ id: `${staff}-suffix`, local: false }, { id: 'learner-id', local: false }, { id: staff, local: true }]) {
      mocks.actor.mockResolvedValue(actor); expect((await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference'])).status).toBe(403);
    }
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('rechecks the allowlist on every detail request and never accepts caller-selected sources', async () => {
    expect((await internalReviewApi(request(), ['evaluations'])).status).toBe(200);
    vi.stubEnv('ADMIN_USER_IDS', ''); expect((await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference'])).status).toBe(403);
    vi.stubEnv('ADMIN_USER_IDS', staff);
    for (const query of ['?source=learner', '?sessionId=private', '?path=/tmp/private.json', '?annotations=forged']) expect((await internalReviewApi(request(query), ['evaluations'])).status).toBe(400);
    expect((await internalReviewApi(request('/unknown'), ['evaluations', 'unknown'])).status).toBe(404);
    expect((await internalReviewApi(request('/../private'), ['evaluations', '..', 'private'])).status).toBe(404);
  });
  it('rejects uploads, annotation writes and arbitrary actions', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await internalReviewApi(request('', method), ['evaluations'])).status).toBe(405);
    expect((await internalReviewApi(request('/money-reference/approve'), ['evaluations', 'money-reference', 'approve'])).status).toBe(404);
    expect(mocks.service).not.toHaveBeenCalled();
  });
});
