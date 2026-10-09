import { expect, test, type Page } from '@playwright/test';
import type { CoachOutput, CoachingReport, CorrectionDraft, SessionView } from '../../lib/interview-practice/types';
import type { Inspection, OwnerCase, StaffStatus } from '../../features/reviews/types';

// Explicit frontend contract fixtures. No provider, runner, staff, or learner API
// is called by these tests; backend authorization is tested separately.
const sessionId = '5a746c15-f4df-42cf-bb7b-68553a5512d7';
const reportId = '5e12a9d5-a439-430f-b837-11b95f9e4215';
const caseId = '6ad12c37-a808-4ce7-821c-c9234aebdebb';
const draftId = '5cc486ed-cd4f-422c-8ad5-a770c45a23e6';
const now = new Date().toISOString();
const later = new Date(Date.now() + 7 * 86400_000).toISOString();
const content: CoachOutput = { overview: 'Fixture provisional practice feedback.', rubric: [{ criterionId: 'reasoning', level: 'Not observed', feedback: 'No explanation was recorded.', evidenceIds: [], confidence: 'low' }], nextPractice: [{ drillId: 'explain-tradeoff', reason: 'Practise explaining a tradeoff.' }] };
const report: CoachingReport = { ...content, id: reportId, generationId: 'generation-fixture-one', createdAt: now, model: 'authored-fixture', promptVersion: '1', rubricVersion: '1.0.0', evidenceDigest: 'fixture-digest', evidence: [{ id: 'evidence-fixture', kind: 'snapshot', label: 'Saved fixture code', content: 'PRIVATE CODE FIXTURE', sha256: 'fixture-sha', source: 'snapshot' }] };
const session: SessionView = {
  id: sessionId, scenarioId: 'fixture-task', scenarioVersion: '1.0.0', mode: 'practice', lifecycle: 'completed', stageId: 'debug', revision: 4,
  configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: false, accommodations: [] },
  scenario: { id: 'fixture-task', version: '1.0.0', title: 'Review contract fixture', summary: 'A frontend-only scenario fixture.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': 'PRIVATE CODE FIXTURE' }, stages: [{ id: 'debug', title: 'Debug', brief: 'Find the issue.', requirements: ['Explain the change.'] }], rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain decisions.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [{ id: 'explain-tradeoff', title: 'Explain a tradeoff', competencyId: 'reasoning', lesson: 'Give a reason.', exercise: 'Explain a choice.' }], rights: 'Fixture only', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 } },
  files: { 'main.py': 'PRIVATE CODE FIXTURE' }, codeFrozenSnapshotId: 'snapshot-fixture', frozenEvidence: { digest: 'fixture-digest', watermark: 3, frozenAt: now, items: report.evidence }, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [report], evidence: report.evidence, usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh',
};
const ownerCase: OwnerCase = { id: caseId, sessionId, reportId, category: 'feedback', message: 'PRIVATE CONCERN FIXTURE', criterionIds: ['reasoning'], status: 'open', revision: 1, inspectionConsent: true, supportActionsConsent: true, consentVersion: 'support-inspection-v1', consentExpiresAt: later, createdAt: now, updatedAt: now };
function statusFor(item = ownerCase, drafts: StaffStatus['drafts'] = []): StaffStatus {
  const { message: _message, criterionIds: _criteria, consentVersion: _consent, resolution: _resolution, ...metadata } = item; void _message; void _criteria; void _consent; void _resolution;
  return { case: metadata, session: { id: sessionId, lifecycle: 'completed', stageId: 'debug', revision: 4, scenarioId: 'fixture-task', scenarioVersion: '1.0.0', acknowledgedSnapshotAt: now, updatedAt: now, usage: session.usage, reports: [{ id: reportId, generationId: report.generationId, createdAt: now, corrected: false }], jobs: [], refundableEntitlement: 'requires-separate-reviewed-policy' }, drafts };
}
function inspectionFor(drafts: Inspection['drafts'] = []): Inspection { return { case: ownerCase, session, snapshots: [{ id: 'snapshot-fixture', sequence: 1, createdAt: now, sha256: 'fixture-sha', files: session.files }], drafts, decisions: [], researchReuseAuthorized: false }; }
const draft: CorrectionDraft = { id: draftId, ownerId: 'owner-fixture', sessionId, caseId, sourceReportId: reportId, reportId: 'corrected-fixture', generationId: 'generation-fixture-two', evidenceDigest: 'fixture-digest', evidenceWatermark: 3, reason: 'Recognize the recorded explanation.', report: content, createdBy: 'staff-author', createdAt: now };

async function baseFixture(page: Page, allowed = true) {
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: `Unexpected fixture request: ${route.request().url()}` } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'owner-fixture', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed } }));
  await page.route(`**/api/interview-practice/sessions/${sessionId}`, route => route.fulfill({ json: { session, scenario: session.scenario, capabilities: { ai: false, runner: false, voice: false, billing: false, accounts: true } } }));
}
async function staffFixture(page: Page, options: { authoredByYou?: boolean; inspectionConsent?: boolean } = {}) {
  await baseFixture(page);
  const state = { status: statusFor({ ...ownerCase, inspectionConsent: options.inspectionConsent ?? true }, [{ id: draft.id, sourceReportId: reportId, createdAt: now, authoredByYou: options.authoredByYou ?? false, decision: null, published: false }]), inspectionCalls: 0, events: [] as string[] };
  await page.route('**/api/internal/reviews', route => route.fulfill({ json: { cases: [state.status.case] } }));
  await page.route(`**/api/internal/reviews/${caseId}`, route => route.fulfill({ json: state.status }));
  await page.route(`**/api/internal/reviews/${caseId}/inspect`, route => { state.inspectionCalls++; expect(route.request().postDataJSON().purpose).toBeTruthy(); return route.fulfill({ json: inspectionFor([{ ...draft, authoredByYou: options.authoredByYou ?? false }]) }); });
  await page.goto('/internal');
  await page.getByRole('button', { name: 'Feedback review · open', exact: false }).click();
  await expect(page.getByRole('heading', { name: 'Private inspection', exact: true })).toBeVisible();
  return state;
}
async function inspect(page: Page) { await page.getByLabel('Inspection purpose', { exact: true }).fill('Resolve the learner feedback concern from frozen evidence.'); await page.getByRole('button', { name: 'Inspect attempt', exact: true }).click(); await expect(page.getByRole('region', { name: 'Inspected private content' })).toBeVisible(); }

test('staff access is checked before navigation or records are displayed', async ({ page }) => {
  await baseFixture(page, false); let calls = 0;
  await page.route('**/api/internal/reviews', route => { calls++; return route.fulfill({ json: { cases: [] } }); });
  await page.goto('/internal'); await expect(page.getByText('This console requires an authorized staff account.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Staff review' })).toHaveCount(0); expect(calls).toBe(0);
});

test('learner permissions start unchecked, can be granted, and can be revoked', async ({ page }, testInfo) => {
  await baseFixture(page, false); let cases: OwnerCase[] = []; const mutations: Record<string, unknown>[] = [];
  await page.route(`**/api/interview-practice/sessions/${sessionId}/reviews`, route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { cases } });
    const body = route.request().postDataJSON(); mutations.push(body); const item = { ...ownerCase, ...body, consentExpiresAt: body.inspectionConsent || body.supportActionsConsent ? later : null }; cases = [item]; return route.fulfill({ status: 201, json: { case: item } });
  });
  await page.route(`**/api/interview-practice/reviews/${caseId}/consent`, route => {
    const body = route.request().postDataJSON(); mutations.push(body); cases = [{ ...cases[0], ...body, revision: cases[0].revision + 1, consentExpiresAt: body.inspectionConsent || body.supportActionsConsent ? later : null }]; return route.fulfill({ json: { case: cases[0] } });
  });
  await page.goto(`/interview-practice/${sessionId}`); await page.getByRole('button', { name: 'Question this feedback' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request a review', exact: true });
  await expect(dialog.getByRole('checkbox', { name: /Allow authorized staff/ })).not.toBeChecked(); await expect(dialog.getByRole('checkbox', { name: /Allow staff to retry/ })).not.toBeChecked();
  await expect(dialog.getByText('This is not permission to reuse your work for research or model training.', { exact: false })).toBeVisible();
  await dialog.getByLabel('Your concern').fill('Please check the reasoning observation against my saved explanation.');
  await dialog.getByRole('button', { name: 'Submit review request' }).click();
  await expect(page.getByText('Feedback review · open', { exact: true })).toBeVisible(); expect(mutations[0].inspectionConsent).toBe(false); expect(mutations[0].supportActionsConsent).toBe(false); expect(mutations[0].reportId).toBe(reportId);
  await page.getByRole('button', { name: 'Change permissions' }).click();
  const consent = page.getByRole('dialog', { name: 'Change support permissions' });
  await consent.getByRole('checkbox', { name: /Allow authorized staff/ }).check(); await consent.getByRole('checkbox', { name: /Allow staff to retry/ }).check(); await consent.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Allowed', { exact: true })).toHaveCount(2); expect(mutations[1].expectedRevision).toBe(1);
  await page.getByRole('button', { name: 'Revoke both permissions' }).click();
  await expect(page.getByText('Support permissions revoked.', { exact: false })).toBeVisible(); expect(mutations[2]).toMatchObject({ expectedRevision: 2, inspectionConsent: false, supportActionsConsent: false });
  expect(mutations.every(body => typeof body.requestId === 'string')).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('learner-review-fixture.png'), fullPage: true });
});

test('staff sees metadata first and revocation hides purpose-backed inspection', async ({ page }, testInfo) => {
  const state = await staffFixture(page);
  expect(state.inspectionCalls).toBe(0); await expect(page.getByText('PRIVATE CONCERN FIXTURE', { exact: true })).toHaveCount(0); await expect(page.getByText('PRIVATE CODE FIXTURE', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Inspect attempt', exact: true })).toBeDisabled();
  await inspect(page); expect(state.inspectionCalls).toBe(1); await expect(page.getByText('PRIVATE CONCERN FIXTURE', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('staff-review-fixture.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('staff-review-mobile-fixture.png'), fullPage: true });
  state.status.case.inspectionConsent = false; state.status.case.revision++;
  await page.getByRole('button', { name: 'Refresh status' }).click(); await expect(page.getByRole('region', { name: 'Inspected private content' })).toHaveCount(0); await expect(page.getByText('PRIVATE CONCERN FIXTURE', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Inspect attempt', exact: true })).toBeDisabled();
});

test('absent consent prevents private inspection', async ({ page }) => {
  const state = await staffFixture(page, { inspectionConsent: false });
  await page.getByLabel('Inspection purpose', { exact: true }).fill('Investigate learner concern.'); await expect(page.getByRole('button', { name: 'Inspect attempt', exact: true })).toBeDisabled(); expect(state.inspectionCalls).toBe(0);
});

test('a draft author cannot approve their own correction', async ({ page }) => {
  await staffFixture(page, { authoredByYou: true }); await inspect(page);
  await expect(page.getByText('You authored this draft. A different authorized staff member must review it.')).toBeVisible(); await expect(page.getByRole('button', { name: 'Approve correction', exact: true })).toHaveCount(0);
});

test('staff recovery requires support permission and cancellation confirmation', async ({ page }) => {
  const state = await staffFixture(page); const jobId = '76512679-71b7-423c-92b2-a2f87ad49c46';
  state.status.session.jobs = [{ id: jobId, kind: 'coach', state: 'failed', attempt: 1, updatedAt: now, failureCategory: 'coach_failed' }]; state.status.session.reports = []; state.status.case.supportActionsConsent = false;
  const actions: Record<string, unknown>[] = [];
  await page.route(`**/api/internal/reviews/${caseId}/recover`, route => { const body = route.request().postDataJSON(); actions.push(body); state.status.session.jobs[0].state = body.action === 'retry-report' ? 'queued' : 'cancelled'; return route.fulfill({ json: { caseId, operation: body.action, job: state.status.session.jobs[0] } }); });
  await page.getByRole('button', { name: 'Refresh status' }).click(); await expect(page.getByRole('button', { name: 'Retry report', exact: true })).toBeDisabled();
  state.status.case.supportActionsConsent = true; await page.getByRole('button', { name: 'Refresh status' }).click(); await expect(page.getByRole('button', { name: 'Retry report', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Retry report', exact: true }).click(); await expect(page.getByText('Report retry requested within the existing limits.')).toBeVisible(); expect(actions).toHaveLength(1);
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click(); expect(actions).toHaveLength(1); await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('Job cancellation recorded.')).toBeVisible(); expect(actions[1]).toMatchObject({ action: 'cancel-job', jobId });
});

test('a resolution is learner-visible and author preview needs its own purpose', async ({ page }) => {
  await staffFixture(page); await inspect(page); let resolved = false; let previews = 0;
  await page.route(`**/api/internal/reviews/${caseId}/resolve`, route => { expect(route.request().postDataJSON().resolution).toBe('The original finding matches the recorded evidence.'); resolved = true; return route.fulfill({ json: { case: { ...ownerCase, status: 'resolved' } } }); });
  await page.getByLabel('Resolution shown to the learner').fill('The original finding matches the recorded evidence.'); await page.getByRole('button', { name: 'Resolve request', exact: true }).click(); await expect(page.getByText('Learner-visible resolution saved.', { exact: false })).toBeVisible(); expect(resolved).toBe(true);
  await page.route('**/api/internal/scenarios/fixture-task/preview', route => { previews++; expect(route.request().postDataJSON().purpose).toBe('Review the authored rubric.'); return route.fulfill({ json: { scenario: { ...session.scenario, referenceFiles: { 'main.py': 'PRIVATE REFERENCE FIXTURE' }, tests: [{ id: 'private-test', title: 'Protected check', visible: false, source: 'PRIVATE TEST FIXTURE', timeoutSeconds: 20 }] }, scenarioDigest: 'package-fixture', privateMaterial: true, executionQualifiedByThisPreview: false } }); });
  await page.getByRole('tab', { name: 'Scenario author preview' }).click(); await page.getByLabel('Scenario ID', { exact: true }).fill('fixture-task'); await expect(page.getByRole('button', { name: 'Preview private package' })).toBeDisabled(); expect(previews).toBe(0);
  await page.getByLabel('Author review purpose').fill('Review the authored rubric.'); await page.getByRole('button', { name: 'Preview private package' }).click(); await expect(page.getByText('Private author material', { exact: false })).toBeVisible(); expect(previews).toBe(1); await page.getByRole('button', { name: 'Hide private package' }).click(); await expect(page.getByText('Private author material', { exact: false })).toHaveCount(0);
});

test('learner can inspect original and corrected report generations separately', async ({ page }) => {
  await baseFixture(page, false);
  await page.route(`**/api/interview-practice/sessions/${sessionId}`, route => route.fulfill({ json: { session: { ...session, reports: [report, { ...report, id: draft.reportId, generationId: draft.generationId, model: 'staff-reviewed', overview: 'Corrected provisional feedback.', correction: { sourceReportId: reportId, reason: draft.reason, publishedAt: now } }] }, scenario: session.scenario, capabilities: { ai: false, runner: false, voice: false, billing: false, accounts: true } } }));
  await page.route(`**/api/interview-practice/sessions/${sessionId}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  await page.goto(`/interview-practice/${sessionId}`); await expect(page.getByRole('heading', { name: 'Staff-reviewed correction' })).toBeVisible(); await expect(page.getByText('Corrected provisional feedback.', { exact: true })).toBeVisible();
  await page.getByLabel('Report version').selectOption(reportId); await expect(page.getByText('Fixture provisional practice feedback.', { exact: true })).toBeVisible(); await expect(page.getByText('You are viewing an earlier report.', { exact: false })).toBeVisible(); await page.getByRole('button', { name: 'View latest report' }).click(); await expect(page.getByText('Corrected provisional feedback.', { exact: true })).toBeVisible();
});

test('independent approval and publication require two distinct explicit actions', async ({ page }) => {
  const state = await staffFixture(page); await inspect(page);
  await page.route(`**/api/internal/reviews/drafts/${draftId}/review`, route => {
    const body = route.request().postDataJSON(); expect(body).toMatchObject({ decision: 'approve', note: 'Checked each finding against frozen evidence.' }); state.events.push('approve'); state.status.drafts[0].decision = 'approve';
    return route.fulfill({ json: { decision: { id: 'decision-fixture', ownerId: 'owner-fixture', sessionId, caseId, draftId, reviewerId: 'different-staff', decision: 'approve', note: body.note, createdAt: now } } });
  });
  await page.route(`**/api/internal/reviews/drafts/${draftId}/publish`, route => { state.events.push('publish'); state.status.case.status = 'resolved'; state.status.drafts[0].published = true; return route.fulfill({ json: { case: { ...ownerCase, status: 'resolved' }, report: { ...report, id: draft.reportId } } }); });
  await expect(page.getByRole('button', { name: 'Publish approved correction', exact: true })).toHaveCount(0);
  await page.getByLabel('Evidence and wording review note').fill('Checked each finding against frozen evidence.'); await page.getByRole('button', { name: 'Approve correction', exact: true }).click();
  await expect(page.getByText('Review decision saved. Approval does not publish the report.')).toBeVisible(); expect(state.events).toEqual(['approve']);
  await page.getByRole('button', { name: 'Publish approved correction', exact: true }).click(); expect(state.events).toEqual(['approve']); await page.getByRole('button', { name: 'Confirm publication' }).click();
  await expect(page.getByText('Approved correction published as a new report generation.', { exact: false })).toBeVisible(); expect(state.events).toEqual(['approve', 'publish']);
});

test('correction drafts preserve source IDs and explicit evidence choices', async ({ page }) => {
  await staffFixture(page); await inspect(page); let body: Record<string, unknown> | null = null;
  await page.route(`**/api/internal/reviews/${caseId}/drafts`, route => { body = route.request().postDataJSON(); return route.fulfill({ json: { draft: { ...draft, id: 'new-draft-fixture', reason: body!.reason, report: body!.report } } }); });
  await page.getByRole('button', { name: 'Draft a correction', exact: true }).click(); await page.getByLabel('Correction reason shown to the learner').fill('Clarify what was actually observed.');
  await page.getByLabel('Finding level').selectOption('Developing'); await expect(page.getByRole('button', { name: 'Save correction draft' })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Saved fixture code · snapshot' }).check(); await page.getByRole('button', { name: 'Save correction draft' }).click();
  await expect(page.getByText('Correction draft saved.', { exact: false })).toBeVisible(); expect(body).toMatchObject({ sourceReportId: reportId, reason: 'Clarify what was actually observed.', report: { rubric: [{ criterionId: 'reasoning', level: 'Developing', evidenceIds: ['evidence-fixture'] }] } });
});

test('inspection retries retain their key and a new inspection gets a new audit key', async ({ page }) => {
  await staffFixture(page); const keys: string[] = [];
  await page.route(`**/api/internal/reviews/${caseId}/inspect`, route => {
    keys.push(route.request().postDataJSON().requestId);
    return route.fulfill(keys.length === 1 ? { status: 503, json: { error: { message: 'Fixture interrupted inspection. Retry.' } } } : { json: inspectionFor() });
  });
  await page.getByLabel('Inspection purpose', { exact: true }).fill('Resolve this learner support concern.'); await page.getByRole('button', { name: 'Inspect attempt', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Review queue' }).getByRole('alert')).toContainText('Fixture interrupted inspection. Retry.');
  await page.getByRole('button', { name: 'Inspect attempt', exact: true }).click(); await expect(page.getByRole('region', { name: 'Inspected private content' })).toBeVisible();
  await page.getByRole('button', { name: 'Hide inspected content' }).click(); await page.getByRole('button', { name: 'Inspect attempt', exact: true }).click(); await expect(page.getByRole('region', { name: 'Inspected private content' })).toBeVisible();
  expect(keys).toHaveLength(3); expect(keys[0]).toBe(keys[1]); expect(keys[2]).not.toBe(keys[1]);
});
