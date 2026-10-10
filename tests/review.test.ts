import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FilePracticeStore } from '../lib/server/store';
import { ReviewService } from '../lib/server/review-service';
import { author, correction, finalAttempt, harness, openCase, other, owner, requestId, reviewer, scenario } from './review-fixtures';
const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('permissioned support and immutable correction workflow', () => {
  it('requires an exact staff allowlist and refuses local identities in production', async () => {
    const context = harness(); expect(context.reviews.allowed(author)).toBe(true); expect(context.reviews.allowed({ id: author.id.toUpperCase(), local: false })).toBe(false);
    await expect(context.reviews.listCases({ id: owner, local: false })).rejects.toMatchObject({ status: 403 });
    vi.stubEnv('NODE_ENV', 'production'); const service = new ReviewService(context.store, () => scenario, { adminUserIds: [author.id], allowLocalAdmins: true });
    expect(service.allowed({ ...author, local: true })).toBe(false);
  });
  it('scopes learner cases and consent updates to the original owner and replays create requests', async () => {
    const context = harness(), session = await finalAttempt(context), request = requestId();
    const input = { requestId: request, category: 'feedback' as const, reportId: session.reports[0].id, message: 'Check the recorded result.', inspectionConsent: false, supportActionsConsent: false };
    expect(await context.reviews.createCase(owner, session.id, input)).toEqual(await context.reviews.createCase(owner, session.id, input));
    const item = (await context.reviews.listOwnerCases(owner, session.id))[0];
    await expect(context.reviews.setConsent(other, item.id, { requestId: requestId(), expectedRevision: item.revision, inspectionConsent: true, supportActionsConsent: true })).rejects.toMatchObject({ code: 'not_found' });
    expect(await context.reviews.listOwnerCases(other)).toEqual([]);
  });
  it('shows only content-free support metadata until the learner permits inspection', async () => {
    const context = harness(), session = await finalAttempt(context, true), item = await openCase(context, session.id, false, false);
    const metadata = JSON.stringify(await context.reviews.status(author, item.id));
    expect(metadata).not.toContain('PRIVATE-'); expect(metadata).toContain('coach_failed');
    await expect(context.reviews.inspect(author, item.id, { requestId: requestId(), purpose: 'Investigate failure.' })).rejects.toMatchObject({ status: 403 });
  });
  it('audits purposeful access, caches only references, and rejects old inspection keys after revocation', async () => {
    const context = harness(), session = await finalAttempt(context), item = await openCase(context, session.id), request = { requestId: requestId(), purpose: 'Check the learner disputed criterion.' };
    expect(JSON.stringify(await context.reviews.inspect(author, item.id, request))).toContain('PRIVATE-LEARNER-CODE');
    await context.reviews.inspect(author, item.id, request);
    const db = await context.store.read(); expect(db.reviews!.audits.filter(audit => audit.action === 'content.inspected')).toHaveLength(1);
    expect(JSON.stringify(db.requests)).not.toContain('PRIVATE-UNPUBLISHED-CORRECTION');
    const updated = await context.reviews.setConsent(owner, item.id, { requestId: requestId(), expectedRevision: item.revision, inspectionConsent: false, supportActionsConsent: false });
    expect(updated.revision).toBe(item.revision + 1);
    await expect(context.reviews.inspect(author, item.id, request)).rejects.toMatchObject({ status: 403 });
    await expect(context.reviews.setConsent(owner, item.id, { requestId: requestId(), expectedRevision: item.revision, inspectionConsent: true, supportActionsConsent: true })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('expires support permission after seven days without authorizing evaluation reuse', async () => {
    let now = new Date('2026-10-09T12:00:00.000Z'); const context = harness(undefined, () => now), session = await finalAttempt(context), item = await openCase(context, session.id);
    expect((await context.reviews.inspect(author, item.id, { requestId: requestId(), purpose: 'Review feedback.' })).researchReuseAuthorized).toBe(false);
    now = new Date(now.getTime() + 7 * 86_400_000);
    await expect(context.reviews.inspect(author, item.id, { requestId: requestId(), purpose: 'Late inspection.' })).rejects.toMatchObject({ status: 403 });
  });
  it('keeps unpublished drafts outside owner session DTOs and rejects invalid evidence/test assertions', async () => {
    const context = harness(), session = await finalAttempt(context), item = await openCase(context, session.id), report = await correction(context, session.id);
    const draft = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Clarify the observed failed check.', report });
    expect(JSON.stringify(await context.practice.getSession(owner, session.id))).not.toContain('PRIVATE-UNPUBLISHED-CORRECTION');
    expect((await context.reviews.status(reviewer, item.id)).drafts[0].id).toBe(draft.id);
    await expect(context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Invalid citation.', report: { ...report, rubric: [{ ...report.rubric[0], evidenceIds: ['invented'] }] } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Unsupported claim.', report: { ...report, overview: 'All tests passed.' } })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('requires a distinct reviewer and approved immutable decision before publishing', async () => {
    const context = harness(), session = await finalAttempt(context), item = await openCase(context, session.id);
    const draft = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Clarify the report.', report: await correction(context, session.id) });
    await expect(context.reviews.reviewDraft(author, draft.id, { requestId: requestId(), decision: 'approve', note: 'Self review.' })).rejects.toMatchObject({ status: 403 });
    await expect(context.reviews.publishDraft(author, draft.id, { requestId: requestId() })).rejects.toMatchObject({ status: 403 });
    await context.reviews.reviewDraft(reviewer, draft.id, { requestId: requestId(), decision: 'reject', note: 'Needs a clearer explanation.' });
    await expect(context.reviews.reviewDraft(reviewer, draft.id, { requestId: requestId(), decision: 'approve', note: 'Changed mind.' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(context.reviews.publishDraft(author, draft.id, { requestId: requestId() })).rejects.toMatchObject({ status: 403 });
  });
  it('publishes a new visible generation atomically while preserving old report and final evidence', async () => {
    const context = harness(), session = await finalAttempt(context), original = structuredClone(session.reports[0]), manifest = structuredClone(session.frozenEvidence), item = await openCase(context, session.id);
    const draft = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: original.id, reason: 'Correct the explanation of recorded test evidence.', report: await correction(context, session.id) });
    await context.reviews.reviewDraft(reviewer, draft.id, { requestId: requestId(), decision: 'approve', note: 'Checked each cited observation and the revised wording.' });
    const key = { requestId: requestId() }, published = await context.reviews.publishDraft(author, draft.id, key);
    expect(await context.reviews.publishDraft(author, draft.id, key)).toEqual(published);
    const updated = await context.practice.getSession(owner, session.id);
    expect(updated.reports).toHaveLength(2); expect(updated.reports[0]).toEqual(original); expect(updated.frozenEvidence).toEqual(manifest);
    expect(updated.reports[1].generationId).not.toBe(original.generationId); expect(updated.reports[1].correction).toMatchObject({ sourceReportId: original.id, reason: draft.reason });
    expect(updated.events.at(-1)?.type).toBe('coaching.corrected'); expect(published.case.status).toBe('resolved');
  });
  it('rechecks revoked permission before publication and prevents concurrent stale drafts publishing', async () => {
    const context = harness(), session = await finalAttempt(context), item = await openCase(context, session.id), report = await correction(context, session.id);
    const a = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'First correction.', report });
    const b = await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Second correction.', report });
    for (const draft of [a,b]) await context.reviews.reviewDraft(reviewer, draft.id, { requestId: requestId(), decision: 'approve', note: 'Checked against frozen evidence.' });
    const current = (await context.reviews.listOwnerCases(owner))[0];
    await context.reviews.setConsent(owner, item.id, { requestId: requestId(), expectedRevision: current.revision, inspectionConsent: false, supportActionsConsent: false });
    await expect(context.reviews.publishDraft(author, a.id, { requestId: requestId() })).rejects.toMatchObject({ status: 403 });
    const revoked = (await context.reviews.listOwnerCases(owner))[0]; await context.reviews.setConsent(owner, item.id, { requestId: requestId(), expectedRevision: revoked.revision, inspectionConsent: true, supportActionsConsent: true });
    const results = await Promise.allSettled([context.reviews.publishDraft(author, a.id, { requestId: requestId() }), context.reviews.publishDraft(author, b.id, { requestId: requestId() })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect((await context.practice.getSession(owner, session.id)).reports).toHaveLength(2);
  });
  it('permits only bounded consented recovery and audits it in the same practice mutation', async () => {
    const context = harness(), session = await finalAttempt(context, true), item = await openCase(context, session.id, false, true);
    const original = (await context.practice.exportSession(owner, session.id)).jobs.find(job => job.kind === 'coach')!;
    const key = { requestId: requestId(), action: 'retry-report' as const }, result = await context.reviews.recover(author, item.id, key);
    expect(await context.reviews.recover(author, item.id, key)).toEqual(result);
    const requeued = (await context.practice.exportSession(owner, session.id)).jobs.find(job => job.kind === 'coach')!; expect(requeued.input).toEqual(original.input); expect(requeued.id).toBe(original.id);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-'); expect((await context.store.read()).reviews!.audits.filter(audit => audit.action === 'support.retry-report')).toHaveLength(1);
    const otherSession = (await context.practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
    const run = await context.practice.requestRun(owner, otherSession.id, { requestId: requestId(), expectedRevision: otherSession.revision });
    await expect(context.reviews.recover(author, item.id, { requestId: requestId(), action: 'cancel-job', jobId: run.job!.id })).rejects.toMatchObject({ code: 'conflict' });
    await context.reviews.recover(author, item.id, { requestId: requestId(), action: 'cancel-job', jobId: requeued.id });
    expect((await context.practice.getJob(owner, requeued.id)).state).toBe('cancelled');
  });
  it('prevents recovery without action permission and leaves no action audit after a failed mutation', async () => {
    const context = harness(), session = await finalAttempt(context, true), item = await openCase(context, session.id, true, false);
    await expect(context.reviews.recover(author, item.id, { requestId: requestId(), action: 'retry-report' })).rejects.toMatchObject({ status: 403 });
    expect((await context.store.read()).reviews!.audits.some(audit => audit.action.startsWith('support.retry'))).toBe(false);
  });
  it('audits author-only package previews without exposing private references to ordinary learners', async () => {
    const context = harness();
    await expect(context.reviews.previewScenario({ id: owner, local: false }, scenario.id, { requestId: requestId(), purpose: 'See answers.' })).rejects.toMatchObject({ status: 403 });
    const preview = await context.reviews.previewScenario(author, scenario.id, { requestId: requestId(), purpose: 'Review original exercise package.' });
    expect(preview.scenario.referenceFiles['main.py']).toBe('PRIVATE-AUTHOR-REFERENCE'); expect(preview.executionQualifiedByThisPreview).toBe(false);
    expect((await context.store.read()).reviews!.audits.at(-1)?.action).toBe('scenario.previewed');
  });
  it('exports owned review content with unpublished disclosure and removes staff IDs/purpose diagnostics', async () => {
    const context = harness(), session = await finalAttempt(context), item = await openCase(context, session.id);
    await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Clarify behavior.', report: await correction(context, session.id) });
    await context.reviews.inspect(author, item.id, { requestId: requestId(), purpose: 'PRIVATE-STAFF-OPERATIONAL-PURPOSE' });
    const text = JSON.stringify(await context.reviews.exportOwner(owner));
    expect(text).toContain('PRIVATE-LEARNER-DISPUTE'); expect(text).toContain('PRIVATE-UNPUBLISHED-CORRECTION'); expect(text).toContain('unpublished-unless-listed'); expect(text).not.toContain(author.id); expect(text).not.toContain('PRIVATE-STAFF-OPERATIONAL-PURPOSE');
    expect((await context.reviews.exportOwner(other)).cases).toEqual([]);
    const second = await finalAttempt(context), secondCase = await openCase(context, second.id);
    const scoped = await context.reviews.exportOwner(owner, session.id);
    expect(scoped.cases).toHaveLength(1); expect(JSON.stringify(scoped)).not.toContain(secondCase.id);
    expect(scoped.audit.every(audit => audit.sessionId === session.id)).toBe(true);
    await expect(context.reviews.exportOwner(other, session.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('durably reloads review contents and deletes all subject copies and cache markers with the attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-review-')); temporary.push(directory);
    const context = harness(new FilePracticeStore(directory)), session = await finalAttempt(context), item = await openCase(context, session.id);
    await context.reviews.createDraft(author, item.id, { requestId: requestId(), sourceReportId: session.reports[0].id, reason: 'Clarify behavior.', report: await correction(context, session.id) });
    const restarted = harness(new FilePracticeStore(directory)); expect((await restarted.reviews.exportOwner(owner)).drafts).toHaveLength(1);
    await restarted.practice.deleteSession(owner, session.id, { requestId: requestId() });
    const stored = await readFile(join(directory, 'practice.json'), 'utf8'); expect(stored).not.toContain('PRIVATE-LEARNER-DISPUTE'); expect(stored).not.toContain('PRIVATE-UNPUBLISHED-CORRECTION');
    expect((await restarted.reviews.exportOwner(owner)).cases).toEqual([]); await expect(restarted.reviews.status(author, item.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});
