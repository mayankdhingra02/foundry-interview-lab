import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../lib/server/http';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), get: vi.fn(), allowed: vi.fn(), listOwnerCases: vi.fn(), createCase: vi.fn(), setConsent: vi.fn(), status: vi.fn(), inspect: vi.fn(), previewScenario: vi.fn(), createDraft: vi.fn(), reviewDraft: vi.fn(), publishDraft: vi.fn(), recover: vi.fn(), resolve: vi.fn(), listCases: vi.fn(), deletionStatus: vi.fn() }));
vi.mock('../lib/server/auth', () => ({ requireActor: mocks.actor }));
vi.mock('../lib/server/review-service', () => ({ getReviewService: mocks.get }));
import { internalReviewApi, ownerReviewConsent, ownerReviews } from '../lib/server/review-api';
import { author, owner, requestId } from './review-fixtures';

const sessionId = 'c5709c86-7453-4b6e-a86f-ae31cf081459';
const caseId = '2d578eb5-aacd-4252-b42f-168058802f17';
const draftId = '73d9bf2c-ac15-4d26-b5c5-09e14cfb6fdd';
const get = (path: string) => new Request(`https://foundry.example/api/${path}`);
const post = (path: string, body: unknown, origin = 'https://foundry.example') => new Request(`https://foundry.example/api/${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
describe('review HTTP ownership, permissions and purpose boundaries', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv('APP_URL', 'https://foundry.example');
    mocks.actor.mockResolvedValue({ id: owner, local: false }); mocks.get.mockResolvedValue(mocks); mocks.allowed.mockReturnValue(false);
    mocks.listOwnerCases.mockResolvedValue([]); mocks.createCase.mockResolvedValue({ id: caseId }); mocks.setConsent.mockResolvedValue({ id: caseId, revision: 2 });
    mocks.status.mockResolvedValue({ case: { id: caseId }, session: { lifecycle: 'completed' }, drafts: [] }); mocks.listCases.mockResolvedValue([]);
    mocks.inspect.mockResolvedValue({ case: { id: caseId }, snapshots: [], researchReuseAuthorized: false });
    mocks.previewScenario.mockResolvedValue({ privateMaterial: true }); mocks.reviewDraft.mockResolvedValue({ decision: 'approve' }); mocks.publishDraft.mockResolvedValue({ case: { id: caseId }, report: { id: 'new' } }); mocks.recover.mockResolvedValue({ caseId, operation: 'retry-report', job: null });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('uses the verified learner identity and returns private no-store envelopes', async () => {
    const response = await ownerReviews(get(`sessions/${sessionId}/reviews`), sessionId);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ cases: [] }); expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.listOwnerCases).toHaveBeenCalledWith(owner, sessionId);
    const body = { requestId: requestId(), category: 'technical', message: 'The report did not finish.', inspectionConsent: false, supportActionsConsent: true };
    expect((await ownerReviews(post('reviews', body), sessionId)).status).toBe(201); expect(mocks.createCase).toHaveBeenCalledWith(owner, sessionId, body);
  });
  it('rejects caller-selected ownership and missing explicit consent fields', async () => {
    const body = { requestId: requestId(), category: 'technical', message: 'Help.', inspectionConsent: false, supportActionsConsent: false };
    expect((await ownerReviews(post('reviews', { ...body, ownerId: author.id }), sessionId)).status).toBe(400);
    const { inspectionConsent: _choice, ...missing } = body; void _choice;
    expect((await ownerReviews(post('reviews', missing), sessionId)).status).toBe(400); expect(mocks.createCase).not.toHaveBeenCalled();
  });
  it('requires CAS for permission changes and blocks cross-origin support mutations', async () => {
    const body = { requestId: requestId(), inspectionConsent: false, supportActionsConsent: false };
    expect((await ownerReviewConsent(post('consent', body), caseId)).status).toBe(400);
    expect((await ownerReviewConsent(post('consent', { ...body, expectedRevision: 1 }, 'https://evil.example'), caseId)).status).toBe(403);
    expect((await ownerReviewConsent(post('consent', { ...body, expectedRevision: 1 }), caseId)).status).toBe(200); expect(mocks.setConsent).toHaveBeenCalledTimes(1);
  });
  it('offers an authenticated access boolean while denying every internal content route', async () => {
    const access = await internalReviewApi(get('internal/access'), ['access']); expect(await access.json()).toEqual({ allowed: false });
    expect((await internalReviewApi(get('internal/reviews'), ['reviews'])).status).toBe(403);
    expect((await internalReviewApi(post('internal/preview', { requestId: requestId(), purpose: 'Preview.' }), ['scenarios','example','preview'])).status).toBe(403);
    expect(mocks.listCases).not.toHaveBeenCalled(); expect(mocks.previewScenario).not.toHaveBeenCalled();
    mocks.actor.mockRejectedValue(new HttpError(401, 'authentication_required', 'Sign in.'));
    expect((await internalReviewApi(get('internal/access'), ['access'])).status).toBe(401);
  });
  it('keeps a status read separate from explicit purposeful inspection', async () => {
    mocks.actor.mockResolvedValue(author); mocks.allowed.mockReturnValue(true);
    expect((await internalReviewApi(get('internal/reviews/x'), ['reviews',caseId])).status).toBe(200); expect(mocks.inspect).not.toHaveBeenCalled();
    expect((await internalReviewApi(post('internal/inspect', { requestId: requestId() }), ['reviews',caseId,'inspect'])).status).toBe(400);
    const body = { requestId: requestId(), purpose: 'Check the disputed criterion against frozen observations.' };
    const response = await internalReviewApi(post('internal/inspect', body), ['reviews',caseId,'inspect']); expect(response.status).toBe(200); expect(mocks.inspect).toHaveBeenCalledWith(author, caseId, body);
  });
  it('rejects arbitrary commands and streams exceeding the bounded JSON input size', async () => {
    mocks.actor.mockResolvedValue(author); mocks.allowed.mockReturnValue(true);
    expect((await internalReviewApi(post('internal/recover', { requestId: requestId(), action: 'execute-sql', sql: 'select 1' }), ['reviews',caseId,'recover'])).status).toBe(400);
    expect((await internalReviewApi(post('internal/inspect', { requestId: requestId(), purpose: 'x'.repeat(2100) }), ['reviews',caseId,'inspect'])).status).toBe(413);
    expect(mocks.recover).not.toHaveBeenCalled(); expect(mocks.inspect).not.toHaveBeenCalled();
  });
  it('routes separate review and publication actions with only server-verified actor identity', async () => {
    mocks.actor.mockResolvedValue(author); mocks.allowed.mockReturnValue(true);
    const review = { requestId: requestId(), decision: 'approve', note: 'Checked the cited evidence and revised wording.' };
    expect((await internalReviewApi(post('internal/review', review), ['reviews','drafts',draftId,'review'])).status).toBe(200); expect(mocks.reviewDraft).toHaveBeenCalledWith(author, draftId, review);
    const publish = { requestId: requestId() };
    expect((await internalReviewApi(post('internal/publish', publish), ['reviews','drafts',draftId,'publish'])).status).toBe(200); expect(mocks.publishDraft).toHaveBeenCalledWith(author, draftId, publish);
    expect((await internalReviewApi(post('internal/publish', { ...publish, reviewerId: 'forged' }), ['reviews','drafts',draftId,'publish'])).status).toBe(400);
  });
  it('requires an explicit audited author-preview POST and refuses unknown internal paths', async () => {
    mocks.actor.mockResolvedValue(author); mocks.allowed.mockReturnValue(true);
    expect((await internalReviewApi(get('internal/preview'), ['scenarios','example','preview'])).status).toBe(404); expect(mocks.previewScenario).not.toHaveBeenCalled();
    const body = { requestId: requestId(), purpose: 'Verify the authored package.', version: '1' };
    expect((await internalReviewApi(post('internal/preview', body), ['scenarios','example','preview'])).status).toBe(200); expect(mocks.previewScenario).toHaveBeenCalledWith(author, 'example', body);
    expect((await internalReviewApi(post('internal/arbitrary', {}), ['sql'])).status).toBe(404);
  });
});
