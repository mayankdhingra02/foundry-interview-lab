import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../lib/interview-practice/domain';
import { evaluationApprovalBinding, evaluationReviewBundleSchema, readEvaluationReviewBundle, EVALUATION_REVIEW_MAX_BYTES } from '../lib/server/evaluation-approval';
import { buildEvaluationRepository, configuredRepositoryEvaluations, prepareEvaluationReviewBundle } from '../lib/server/evaluation-library';
import { hypotheticalApproval, reviewerIds, reviewNow } from './evaluation-approval-fixtures';

const folders: string[] = [];
async function privateFile(value: unknown = hypotheticalApproval().bundle) {
  const folder = await mkdtemp(join(await realpath(tmpdir()), 'foundry-evaluation-review-')); folders.push(folder); await chmod(folder, 0o700);
  const path = join(folder, 'review.json'), bytes = JSON.stringify(value);
  await writeFile(path, bytes, { mode: 0o600 });
  const env = { EVALUATION_REVIEW_BUNDLE_PATH: path, EVALUATION_REVIEW_BUNDLE_SHA256: createHash('sha256').update(bytes).digest('hex'), EVALUATION_REVIEWER_IDS: reviewerIds.join(',') };
  return { folder, path, env };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('explicit fixed-synthetic display approval', () => {
  it('prepares exact bindings offline without generating a claimed approval or human work', () => {
    const fixture = hypotheticalApproval(), prepared = prepareEvaluationReviewBundle(fixture.candidates, fixture.annotations);
    expect(prepared.bundle.approvals).toEqual([]); expect(prepared.bindings).toEqual([fixture.bundle.approvals[0].binding]);
    const empty = structuredClone(fixture.annotations); empty.cases[0].reviews = []; empty.cases[0].adjudication = null;
    expect(prepareEvaluationReviewBundle(fixture.candidates, empty).bindings).toEqual([]);
  });
  it('exposes validated candidate output only for a bound approval and strips private material', () => {
    const { source } = hypotheticalApproval(), result = buildEvaluationRepository(source), detail = result.details[0];
    expect(detail).toMatchObject({ approvalStatus: 'approved', annotationStatus: 'adjudicated', displayApproval: { status: 'approved' } });
    expect(detail.approvedContent!.report.overview).toContain('HYPOTHETICAL-DISPLAY-OUTPUT');
    expect(detail.approvedContent!.evidence.map(row => row.id)).toEqual(expect.arrayContaining(detail.approvedContent!.report.rubric.flatMap(row => row.evidenceIds)));
    const serialized = JSON.stringify(result);
    for (const privateValue of ['PRIVATE-', ...reviewerIds]) expect(serialized).not.toContain(privateValue);
    expect(detail.approvedContent!.evidence.every(row => !('content' in row))).toBe(true);
    expect(result.catalog.qualification.status).toBe('pending');
    expect(result.catalog.qualification.approvedExamples).toBe(1);
    expect(result.details.slice(1).every(row => !row.approvedContent)).toBe(true);
  });
  it('can display a human-authorized bad-output example without passing its model quality gate', () => {
    const fixture = hypotheticalApproval(); fixture.annotations.cases[0].adjudication!.claims[0].supported = false;
    fixture.bundle.approvals[0].binding = evaluationApprovalBinding(fixture.bundle.benchmarkVersion, fixture.attempt, fixture.candidates.candidates[0], fixture.annotations.cases[0], { candidates: fixture.candidates, annotations: fixture.annotations });
    const result = buildEvaluationRepository(fixture.source);
    expect(result.details[0].approvedContent).toBeDefined(); expect(result.catalog.qualification.status).toBe('blocked');
    expect(result.catalog.qualification.blockingReasons).toContain('Substantive claim support is below 95%.');
  });
  it('never substitutes adjudication for approval and removes content on revocation/expiry/identity removal', () => {
    const absent = hypotheticalApproval(); absent.bundle.approvals = [];
    expect(buildEvaluationRepository(absent.source).details[0]).toMatchObject({ annotationStatus: 'adjudicated', approvalStatus: 'pending' });
    expect(buildEvaluationRepository(absent.source).details[0].approvedContent).toBeUndefined();
    for (const reason of ['revoked', 'expired', 'reviewer-unrecognized'] as const) {
      const item = hypotheticalApproval();
      if (reason === 'revoked') item.bundle.approvals[0].decision = 'revoked';
      if (reason === 'expired') item.review.now = Date.parse(item.bundle.approvals[0].expiresAt);
      if (reason === 'reviewer-unrecognized') item.review.authorizedReviewerIds = new Set(reviewerIds.slice(1));
      const detail = buildEvaluationRepository(item.source).details[0];
      expect(detail.displayApproval?.reason).toBe(reason); expect(detail.approvedContent).toBeUndefined();
    }
  });
  it('requires complete bound authorized reviews and chronological non-future approval', () => {
    for (const operation of ['incomplete', 'future', 'before-review', 'invalid-expiry'] as const) {
      const item = hypotheticalApproval(), record = item.bundle.approvals[0];
      if (operation === 'incomplete') { item.annotations.cases[0].reviews.pop(); record.binding = evaluationApprovalBinding(item.bundle.benchmarkVersion, item.attempt, item.candidates.candidates[0], item.annotations.cases[0], { candidates: item.candidates, annotations: item.annotations }); }
      if (operation === 'future') record.decidedAt = '2026-10-13T00:00:00.000Z';
      if (operation === 'before-review') record.decidedAt = '2026-10-09T00:00:00.000Z';
      if (operation === 'invalid-expiry') record.expiresAt = record.decidedAt;
      expect(buildEvaluationRepository(item.source).details[0].approvedContent, operation).toBeUndefined();
    }
  });
  it('invalidates every exact binding dimension rather than carrying approval forward', () => {
    const original = hypotheticalApproval().bundle.approvals[0].binding;
    for (const key of Object.keys(original) as (keyof typeof original)[]) {
      const item = hypotheticalApproval(); item.bundle.approvals[0].binding[key] = key.toLowerCase().includes('digest') ? '0'.repeat(64) : 'changed';
      if (key === 'caseId') { expect(() => buildEvaluationRepository(item.source)).toThrow(); continue; }
      const detail = buildEvaluationRepository(item.source).details[0];
      expect(detail.approvedContent, key).toBeUndefined(); expect(detail.approvalStatus, key).toBe('blocked');
    }
    const changed = hypotheticalApproval(); changed.candidates.candidates[0].report.overview += ' changed';
    expect(buildEvaluationRepository(changed.source).details[0].approvedContent).toBeUndefined();
  });
  it('rejects duplicate/unknown approvals, false attestations and source substitution', () => {
    const duplicate = hypotheticalApproval(); duplicate.bundle.approvals.push(duplicate.bundle.approvals[0]); expect(() => buildEvaluationRepository(duplicate.source)).toThrow();
    const unknown = hypotheticalApproval(); unknown.bundle.approvals[0].binding.caseId = 'learner-attempt'; expect(() => buildEvaluationRepository(unknown.source)).toThrow();
    const falseApproval = hypotheticalApproval(); (falseApproval.bundle.approvals[0].attestations as { privacyReviewed: boolean }).privacyReviewed = false; expect(() => evaluationReviewBundleSchema.parse(falseApproval.bundle)).toThrow();
    for (const key of ['recipesDigest', 'captureDigest', 'baselineDigest'] as const) { const item = hypotheticalApproval(); item.bundle[key] = '0'.repeat(64); expect(() => buildEvaluationRepository(item.source)).toThrow(); }
    const mixed = hypotheticalApproval(); mixed.source.candidates = null; expect(() => buildEvaluationRepository(mixed.source)).toThrow();
    const extras = hypotheticalApproval(); expect(() => evaluationReviewBundleSchema.parse({ ...extras.bundle, privateCorpus: {} })).toThrow();
  });
});

describe('private configured read-only review import', () => {
  it('defaults to pending without reading private artifacts and requires a complete configuration', async () => {
    expect(await readEvaluationReviewBundle({})).toBeUndefined();
    for (const env of [{ EVALUATION_REVIEW_BUNDLE_PATH: '/missing' }, { EVALUATION_REVIEW_BUNDLE_SHA256: 'a'.repeat(64) }, { EVALUATION_REVIEWER_IDS: 'someone' }]) await expect(readEvaluationReviewBundle(env)).rejects.toMatchObject({ code: 'evaluation_review_unavailable' });
  });
  it('reads an exact pinned artifact outside Git and rechecks policy/file changes on each request', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(reviewNow);
    const item = await privateFile();
    for (const [key, value] of Object.entries(item.env)) vi.stubEnv(key, value);
    expect((await configuredRepositoryEvaluations()).details[0].approvedContent).toBeDefined();
    vi.stubEnv('EVALUATION_REVIEWER_IDS', reviewerIds.slice(1).join(','));
    expect((await configuredRepositoryEvaluations()).details[0].approvedContent).toBeUndefined();
    vi.stubEnv('EVALUATION_REVIEWER_IDS', reviewerIds.join(','));
    await writeFile(item.path, JSON.stringify({ ...hypotheticalApproval().bundle, scope: 'learner-private' }));
    await expect(configuredRepositoryEvaluations()).rejects.toMatchObject({ code: 'evaluation_review_unavailable' });
  });
  it('rejects symlinks, hardlinks, public permissions, Git/project paths, large or mismatched files', async () => {
    const item = await privateFile();
    await expect(readEvaluationReviewBundle({ ...item.env, EVALUATION_REVIEW_BUNDLE_PATH: 'relative.json' })).rejects.toThrow();
    await expect(readEvaluationReviewBundle({ ...item.env, EVALUATION_REVIEW_BUNDLE_PATH: join(process.cwd(), 'evals/fixtures/attempts.json') })).rejects.toThrow();
    const symbolic = join(item.folder, 'symbolic.json'); await symlink(item.path, symbolic); await expect(readEvaluationReviewBundle({ ...item.env, EVALUATION_REVIEW_BUNDLE_PATH: symbolic })).rejects.toThrow();
    const hard = join(item.folder, 'hard.json'); await link(item.path, hard); await expect(readEvaluationReviewBundle(item.env)).rejects.toThrow(); await rm(hard);
    await chmod(item.path, 0o644); await expect(readEvaluationReviewBundle(item.env)).rejects.toThrow(); await chmod(item.path, 0o600);
    await chmod(item.folder, 0o755); await expect(readEvaluationReviewBundle(item.env)).rejects.toThrow(); await chmod(item.folder, 0o700);
    await mkdir(join(item.folder, '.git')); await expect(readEvaluationReviewBundle(item.env)).rejects.toThrow(); await rm(join(item.folder, '.git'), { recursive: true });
    await expect(readEvaluationReviewBundle({ ...item.env, EVALUATION_REVIEW_BUNDLE_SHA256: '0'.repeat(64) })).rejects.toThrow();
    await expect(readEvaluationReviewBundle({ ...item.env, EVALUATION_REVIEWER_IDS: 'same,SAME' })).rejects.toThrow();
    await writeFile(item.path, ' '.repeat(EVALUATION_REVIEW_MAX_BYTES + 1)); await expect(readEvaluationReviewBundle(item.env)).rejects.toThrow();
  });
  it('keeps invalid content and filesystem locations out of errors', async () => {
    const item = await privateFile({ PRIVATE_SECRET_MARKER: 'private-content' });
    try { await readEvaluationReviewBundle(item.env); throw new Error('Expected rejection'); }
    catch (error) { expect(String(error)).toContain('No approved content'); expect(String(error)).not.toContain('PRIVATE_SECRET'); expect(String(error)).not.toContain(item.path); }
    expect(digest(hypotheticalApproval().bundle)).toMatch(/^[a-f0-9]{64}$/);
  });
});
