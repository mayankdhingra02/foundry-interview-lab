import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from '../lib/server/http';
import { hypotheticalApproval, reviewerIds, reviewNow } from './evaluation-approval-fixtures';
const mocks = vi.hoisted(() => ({ actor: vi.fn(), service: vi.fn() }));
vi.mock('../lib/server/auth', () => ({ requireActor: mocks.actor }));
vi.mock('../lib/server/review-service', async original => ({ ...await original<typeof import('../lib/server/review-service')>(), getReviewService: mocks.service }));
import { internalReviewApi } from '../lib/server/review-api';

const staff = '11dc5c01-f748-46b7-b699-0b55f316a3c6';
const request = (suffix = '', method = 'GET') => new Request(`https://foundry.example/api/internal/evaluations${suffix}`, { method, headers: { origin: 'https://foundry.example' } });
let folder = '', path = '';
async function install(value: unknown) {
  const bytes = JSON.stringify(value); await writeFile(path, bytes, { mode: 0o600 });
  vi.stubEnv('EVALUATION_REVIEW_BUNDLE_SHA256', createHash('sha256').update(bytes).digest('hex'));
}
describe('private approval import stays behind exact staff authorization', () => {
  beforeEach(async () => {
    vi.resetAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(reviewNow);
    folder = await mkdtemp(join(await realpath(tmpdir()), 'foundry-approval-api-')); await chmod(folder, 0o700); path = join(folder, 'private.json');
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APP_URL', 'https://foundry.example'); vi.stubEnv('ADMIN_USER_IDS', staff);
    vi.stubEnv('EVALUATION_REVIEW_BUNDLE_PATH', path); vi.stubEnv('EVALUATION_REVIEWER_IDS', reviewerIds.join(','));
    mocks.actor.mockResolvedValue({ id: staff, local: false }); mocks.service.mockRejectedValue(new Error('No learner/support store should be opened.'));
    await install(hypotheticalApproval().bundle);
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(folder, { force: true, recursive: true }); });
  it('returns only approved fixed output and safe metadata with no-store headers', async () => {
    const response = await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference']);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
    const result = await response.json(); expect(result.example.approvedContent.report.overview).toContain('HYPOTHETICAL-DISPLAY-OUTPUT');
    const serialized = JSON.stringify(result); for (const hidden of ['PRIVATE-', folder, ...reviewerIds]) expect(serialized).not.toContain(hidden);
    const pending = await internalReviewApi(request('/money-starter'), ['evaluations', 'money-starter']); expect((await pending.json()).example.approvedContent).toBeUndefined();
    expect(mocks.service).not.toHaveBeenCalled();
  });
  it('removes output on the next request after revocation or recognized identity removal', async () => {
    const initial = await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference']); expect((await initial.json()).example.approvedContent).toBeDefined();
    const revoked = hypotheticalApproval(); revoked.bundle.approvals[0].decision = 'revoked'; await install(revoked.bundle);
    const after = await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference']); expect((await after.json()).example).toMatchObject({ approvalStatus: 'revoked' });
    expect(JSON.stringify(await (await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference'])).json())).not.toContain('HYPOTHETICAL-DISPLAY-OUTPUT');
    await install(hypotheticalApproval().bundle); vi.stubEnv('EVALUATION_REVIEWER_IDS', reviewerIds.slice(1).join(','));
    const removed = await internalReviewApi(request('/money-reference'), ['evaluations', 'money-reference']); const result = await removed.json();
    expect(result.example.approvalStatus).toBe('blocked'); expect(result.example.approvedContent).toBeUndefined();
  });
  it('denies callers before inspecting a configured private file and rejects source/approval writes', async () => {
    vi.stubEnv('EVALUATION_REVIEW_BUNDLE_PATH', '/PRIVATE-INVALID-PATH');
    mocks.actor.mockRejectedValueOnce(new HttpError(401, 'authentication_required', 'Sign in.')); expect((await internalReviewApi(request(), ['evaluations'])).status).toBe(401);
    for (const actor of [{ id: 'ordinary-learner', local: false }, { id: `${staff}-suffix`, local: false }, { id: staff, local: true }]) { mocks.actor.mockResolvedValue(actor); expect((await internalReviewApi(request(), ['evaluations'])).status).toBe(403); }
    mocks.actor.mockResolvedValue({ id: staff, local: false });
    expect((await internalReviewApi(request('?path=/private'), ['evaluations'])).status).toBe(400);
    expect((await internalReviewApi(request('', 'POST'), ['evaluations'])).status).toBe(405);
    const failed = await internalReviewApi(request(), ['evaluations']); expect(failed.status).toBe(503);
    const result = JSON.stringify(await failed.json()); expect(result).not.toContain('PRIVATE-INVALID-PATH'); expect(result).not.toContain('HYPOTHETICAL-DISPLAY-OUTPUT'); expect(mocks.service).not.toHaveBeenCalled();
  });
});
