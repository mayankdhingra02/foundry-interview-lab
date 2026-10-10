import { expect, test, type Page } from '@playwright/test';
import type { EvaluationExample, EvaluationLibrary } from '../../lib/server/evaluation-library';

// Browser contract fixtures only. These are not saved approvals, independent
// expert judgments, provider outputs, learner attempts or acceptance evidence.
const example: EvaluationExample = {
  id: 'fixture-approved', scenario: { id: 'fixture-scenario', title: 'Synthetic teaching example', version: '1.0.0' }, variant: 'starter', condition: 'unsupported-model-finding', provenance: 'developer-authored-synthetic', annotationStatus: 'adjudicated', approvalStatus: 'approved', reviewCount: 2, disagreementCount: 1, candidateRecorded: true,
  source: { benchmarkVersion: 'browser-fixture', provenance: 'Hypothetical browser data only.', fixturePath: 'fixed-fixture', contextDigest: 'a'.repeat(64) },
  brief: { summary: 'A synthetic contract.', stages: [], rubric: [] }, syntheticDialogue: [], reviewFocus: ['Inspect the unsupported finding.'],
  execution: { status: 'not-executed', relationshipToFinalSnapshot: 'not-executed', recordedAt: null, runtimeDigest: null, suiteCount: 0, passedSuites: 0, failedSuites: 0, unresolvedSuites: 0, provenance: 'No execution in this browser fixture.' },
  annotations: { status: 'adjudicated', reason: 'Hypothetical paired review DTO.', adjudicationRecorded: true, adjudicatedAt: '2026-10-09T01:00:00.000Z', disagreements: [{ kind: 'claim', item: 'Substantive claim 1', reviewerOne: 'Supported', reviewerTwo: 'Unsupported', adjudication: 'Unsupported' }] },
  candidate: { digest: 'b'.repeat(64), model: 'browser-placeholder-only', promptVersion: 'fixture-1', rubricVersion: '1.0.0', createdAt: '2026-10-09T00:00:00.000Z' },
  displayApproval: { status: 'approved', reason: 'approved', decidedAt: '2026-10-09T02:00:00.000Z', expiresAt: '2026-11-09T02:00:00.000Z', artifactDigest: 'c'.repeat(64) },
  approvedContent: { report: { overview: 'DISPLAY-ONLY-MODEL-OUTPUT <script>window.approvalInjected=true</script>', rubric: [{ criterionId: 'fixture-criterion', level: 'Developing', feedback: 'A hypothetical unsupported conclusion for reviewer inspection.', evidenceIds: ['turn:fixture-answer'], confidence: 'medium' }], nextPractice: [{ drillId: 'fixture-drill', reason: 'Hypothetical proposed practice.' }] }, proposal: { action: 'ask_probe', question: 'Which observation supports your conclusion?', competencyId: 'fixture-criterion', probeId: 'fixture-probe', evidenceIds: ['turn:fixture-answer'] }, evidence: [{ id: 'turn:fixture-answer', kind: 'utterance', sha256: 'd'.repeat(64), turnId: 'fixture-answer' }] },
};
const pending = { ...example, id: 'fixture-pending', annotationStatus: 'pending' as const, approvalStatus: 'pending' as const, reviewCount: 0, disagreementCount: null, candidateRecorded: false };
const catalog: EvaluationLibrary = { benchmarkVersion: 'browser-fixture', provenance: 'Hypothetical browser data only.', sourcePolicy: 'Fixed synthetic browser fixture.', examples: [example, pending], qualification: { status: 'blocked', reviewedAttempts: 1, totalAttempts: 2, recordedCandidates: 1, pendingReasons: [], blockingReasons: ['Hypothetical unsupported finding blocks model qualification.'], baselineRecordedAt: '2026-10-09T00:00:00.000Z', approval: 'recorded', approvedExamples: 1 } };
async function fixtures(page: Page) {
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'fixture-staff', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: true } }));
  await page.route('**/api/internal/reviews', route => route.fulfill({ json: { cases: [] } }));
  await page.route('**/api/internal/evaluations', route => route.fulfill({ json: catalog }));
  await page.route('**/api/internal/evaluations/fixture-approved', route => route.fulfill({ json: { example } }));
  await page.route('**/api/internal/evaluations/fixture-pending', route => route.fulfill({ json: { example: { ...pending, displayApproval: { status: 'pending', reason: 'not-recorded' }, approvedContent: undefined } } }));
  await page.goto('/internal'); await page.getByRole('tab', { name: 'Evaluation', exact: true }).click();
}

test('approved output is read-only escaped content, separate from blocked quality; filters work by keyboard/mobile', async ({ page }, testInfo) => {
  await fixtures(page); const panel = page.getByRole('tabpanel', { name: 'Evaluation', exact: true }); const filter = panel.getByRole('combobox', { name: 'Display approval', exact: true });
  await filter.selectOption('approved'); await filter.focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Refresh examples' })).toBeFocused();
  await expect(page.getByRole('button', { name: /fixture-pending/ })).toHaveCount(0);
  await page.getByRole('button', { name: /fixture-approved/ }).click();
  const detail = page.getByRole('article', { name: 'Synthetic example detail' });
  await expect(detail.getByRole('region', { name: 'Approved candidate output' })).toContainText('DISPLAY-ONLY-MODEL-OUTPUT <script>');
  await expect(panel.getByRole('status')).toContainText('AI qualification: blocked');
  await expect(detail).toContainText('it does not establish that the findings are correct');
  expect(await page.evaluate(() => 'approvalInjected' in window)).toBe(false);
  await detail.getByText('Evidence identifiers and immutable metadata', { exact: true }).click(); await expect(detail).toContainText('turn:fixture-answer');
  await detail.getByRole('heading', { name: 'Approved candidate output', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('approved-output-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await detail.getByRole('heading', { name: 'Approved candidate output', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('approved-output-mobile.png') });
});

test('refresh removes revoked output instead of retaining content behind a badge', async ({ page }) => {
  await fixtures(page); await page.getByRole('button', { name: /fixture-approved/ }).click(); await expect(page.getByText(/DISPLAY-ONLY-MODEL-OUTPUT/)).toBeVisible();
  const revoked = { ...example, approvalStatus: 'revoked' as const, displayApproval: { ...example.displayApproval!, status: 'revoked' as const, reason: 'revoked' as const }, approvedContent: undefined };
  await page.route('**/api/internal/evaluations', route => route.fulfill({ json: { ...catalog, examples: [revoked], qualification: { ...catalog.qualification, approvedExamples: 0 } } }));
  await page.route('**/api/internal/evaluations/fixture-approved', route => route.fulfill({ json: { example: revoked } }));
  await page.getByRole('button', { name: 'Refresh examples' }).click(); await expect(page.getByText(/DISPLAY-ONLY-MODEL-OUTPUT/)).toHaveCount(0);
  await page.getByRole('button', { name: /fixture-approved/ }).click(); await expect(page.getByRole('article')).toContainText('Display approval revoked'); await expect(page.getByRole('region', { name: 'Approved candidate output' })).toHaveCount(0);
});

test('unapproved or invalidated source never retains the previously displayed report/proposal', async ({ page }) => {
  await fixtures(page); const panel = page.getByRole('tabpanel', { name: 'Evaluation', exact: true }); await page.getByRole('button', { name: /fixture-pending/ }).click(); await expect(page.getByRole('region', { name: 'Approved candidate output' })).toHaveCount(0);
  await page.getByRole('button', { name: /fixture-approved/ }).click(); await expect(page.getByText(/DISPLAY-ONLY-MODEL-OUTPUT/)).toBeVisible();
  await page.route('**/api/internal/evaluations', route => route.fulfill({ status: 503, json: { error: { message: 'The configured evaluation review artifact is unavailable or invalid. No approved content is displayed.' } } }));
  await page.getByRole('button', { name: 'Refresh examples' }).click(); await expect(panel.getByRole('alert')).toContainText('No approved content is displayed.');
  await expect(page.getByText(/DISPLAY-ONLY-MODEL-OUTPUT/)).toHaveCount(0); await expect(page.getByRole('region', { name: 'Approved candidate output' })).toHaveCount(0);
});
