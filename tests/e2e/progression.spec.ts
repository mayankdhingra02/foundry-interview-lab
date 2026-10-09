import { expect, test, type Page } from '@playwright/test';
import { buildProgression } from '../../lib/interview-practice/progression';
import type { PublicScenario, RubricLevel, SessionView } from '../../lib/interview-practice/types';

// Frontend contract checks using explicit authored fixtures and the pure planning
// policy. All HTTP is intercepted; no learner/provider/runner API is invoked.
function scenario(id: string, criterion: string, title: string): PublicScenario {
  return { id, version: '1.0.0', title, summary: 'Browser contract fixture.', durationMinutes: 30, level: 'Mid-level', tags: ['validation'], language: 'python', files: { 'main.py': '# Fixture' }, stages: [{ id: 'debug', title: 'Inspect', brief: 'Inspect the fixture.', requirements: ['Explain a check.'] }], rubric: [{ id: criterion, name: criterion === 'money-validation' ? 'Input validation' : criterion === 'stock-atomicity' ? 'Atomic updates' : 'Conflict handling', description: 'Fixture criterion.', anchors: { strong: 'Explained', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [{ id: `${criterion}-drill`, title: `Practise ${criterion}`, competencyId: criterion, lesson: 'ORIGINAL LESSON FIXTURE', exercise: 'ORIGINAL EXERCISE FIXTURE' }], rights: 'Original fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 } };
}
const catalog = [scenario('monetary-validation', 'money-validation', 'Validate monetary input'), scenario('duplicate-invoice', 'invoice-conflicts', 'Handle invoice conflicts'), scenario('inventory-reservations', 'stock-atomicity', 'Reserve stock atomically')];
function attempt(id: string, date: string, level: RubricLevel = 'Developing'): SessionView {
  const task = catalog[0]; const evidence = [{ id: `evidence-${id}`, kind: 'snapshot' as const, label: 'Synthetic fixture observation', content: 'Synthetic browser fixture evidence.', sha256: 'a'.repeat(64), source: 'snapshot' }];
  return { id, scenarioId: task.id, scenarioVersion: task.version, scenario: task, mode: 'practice', lifecycle: 'completed', stageId: 'debrief', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['validation'], targetMinutes: 30, aiHelp: true, accommodations: [] }, files: task.files, codeFrozenSnapshotId: `snapshot-${id}`, frozenEvidence: { digest: `digest-${id}`, watermark: 1, items: evidence, frozenAt: date }, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [{ id: `report-${id}`, generationId: `generation-${id}`, createdAt: date, model: 'authored-browser-fixture', promptVersion: 'fixture-v1', rubricVersion: task.version, evidenceDigest: `digest-${id}`, evidence, overview: 'Synthetic provisional feedback.', rubric: [{ criterionId: 'money-validation', level, feedback: 'Synthetic evidence-linked finding.', evidenceIds: level === 'Not observed' ? [] : [evidence[0].id], confidence: 'low' }], nextPractice: [{ drillId: task.drills[0].id, reason: 'Synthetic practice selection.' }] }], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: date, updatedAt: date, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh', evidence };
}
function recordedAttempts() {
  const first = attempt('first-attempt', '2026-10-08T12:00:00.000Z');
  const repeated = attempt('repeated-attempt', '2026-10-09T12:00:00.000Z', 'Needs work'); repeated.promptExposure = 'repeated'; repeated.hintsOpened = 1; repeated.configuration.accommodations = ['extra-time'];
  repeated.assistantMessages.push({ id: 'assistant-fixture', role: 'assistant', text: 'Synthetic guidance.', createdAt: repeated.createdAt });
  repeated.completedDrillIds = [catalog[0].drills[0].id];
  const correction = structuredClone(repeated.reports[0]); correction.id = 'corrected-report'; correction.model = 'staff-reviewed'; correction.createdAt = '2026-11-02T12:00:00.000Z'; correction.correction = { sourceReportId: repeated.reports[0].id, reason: 'Synthetic correction.', publishedAt: correction.createdAt }; repeated.reports.push(correction);
  return [first, repeated];
}
async function fixture(page: Page, options: { sessions?: SessionView[]; catalog?: PublicScenario[]; catalogFailure?: boolean; lessonOrigin?: string } = {}) {
  const sessions = options.sessions || []; const tasks = options.catalog || catalog; const requests: string[][] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: `Unexpected fixture request: ${route.request().url()}` } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'progression-fixture-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill(options.catalogFailure ? { status: 503, json: { error: { message: 'Fixture catalog unavailable.' } } } : { json: { scenarios: tasks, capabilities: { ai: false, runner: false, voice: false, billing: false, accounts: true } } }));
  await page.route('**/api/interview-practice/progress*', route => {
    const ids = new URL(route.request().url()).searchParams.getAll('competency'); requests.push(ids);
    const known = new Set([...tasks, ...sessions.map(item => item.scenario)].flatMap(task => task.rubric.map(row => row.id)));
    if (ids.length > 20 || ids.some(id => !known.has(id))) return route.fulfill({ status: 400, json: { error: { message: 'Choose only available practice criteria, or clear the selection.' } } });
    const result = buildProgression(sessions, tasks, { selectedCompetencies: ids });
    if (options.lessonOrigin) for (const step of result.studyPlan.steps) if (step.kind === 'lesson') step.navigation = { status: 'available', href: options.lessonOrigin + step.foundryPath };
    return route.fulfill({ json: result });
  });
  return requests;
}

test('cold start offers bounded practice without inferring a weakness', async ({ page }, testInfo) => {
  await fixture(page); await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Start collecting practice evidence' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'No completed observations yet' })).toBeVisible();
  await expect(page.getByText('There are no completed report observations yet.', { exact: false })).toBeVisible(); await expect(page.locator('.progression-step')).toHaveCount(1); await expect(page.locator('.progression-skill')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Set up practice', exact: true })).toHaveAttribute('href', /\/interview-practice\?scenario=/);
  await page.screenshot({ path: testInfo.outputPath('cold-start.png'), fullPage: true });
});

test('goals use repeated exact criterion parameters and update only on apply', async ({ page }) => {
  const requests = await fixture(page); await page.goto('/progress'); await expect(page.getByRole('heading', { name: 'Start collecting practice evidence' })).toBeVisible();
  await page.getByText('Choose practice goals (optional)', { exact: true }).click(); const initial = requests.length;
  await page.getByRole('checkbox', { name: 'Atomic updates', exact: true }).check(); await page.getByRole('checkbox', { name: 'Input validation', exact: true }).check(); expect(requests).toHaveLength(initial);
  await page.getByRole('button', { name: 'Apply goals' }).click(); await expect(page).toHaveURL(/competency=money-validation&competency=stock-atomicity/); expect(requests.at(-1)).toEqual(['stock-atomicity', 'money-validation']);
  // Request order follows the user's selection; the policy returns canonical order.
  expect(new URL(page.url()).searchParams.getAll('competency')).toEqual(['money-validation', 'stock-atomicity']);
  await page.getByRole('button', { name: 'Clear goals', exact: true }).click(); await expect(page).toHaveURL(/\/progress$/); expect(requests.at(-1)).toEqual([]);
});

test('observations retain dates, fresh/repeat/help and assessment provenance', async ({ page }, testInfo) => {
  await fixture(page, { sessions: recordedAttempts() }); await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Your next practice steps' })).toBeVisible(); await expect(page.locator('.progression-step')).toHaveCount(3); await expect(page.getByText('corrections keep the original observation date.', { exact: false })).toBeVisible();
  await page.locator('.progression-skill > summary').click(); await expect(page.locator('.progression-skill-count')).toContainText('2 observations · 2 evidence references');
  const latest = page.locator('.progression-observation').first();
  await expect(latest).toContainText('Repeated task'); await expect(latest).toContainText('Help received · AI help permitted · Staff-reviewed feedback · Corrected report'); await expect(latest.locator('time')).toHaveAttribute('datetime', '2026-10-09T12:00:00.000Z');
  await expect(page.locator('.progression-observation').last()).toContainText('Fresh task'); await expect(page.locator('.progression-observation').last()).toContainText('No help recorded · AI help permitted · Authored feedback');
  await latest.getByText('Evidence and assessment details', { exact: true }).click(); await expect(latest).toContainText('1 assistant response'); await expect(latest).toContainText('1 accommodation configured; no penalty applied.'); await expect(latest).toContainText('corrected-report'); await expect(latest).toContainText('evidence-repeated-attempt');
  await expect(latest.getByRole('link', { name: /Review monetary-validation attempt/ })).toHaveAttribute('href', '/interview-practice/repeated-attempt');
  await page.getByText('Review the original drill', { exact: true }).click(); await expect(page.getByText('ORIGINAL EXERCISE FIXTURE')).toBeVisible(); await expect(page.getByText('Completion self-reported', { exact: false })).toBeVisible();
  await expect(page.getByText('Navigation unavailable in this app · Foundry integration pending')).toBeVisible(); await expect(page.locator('a[href^="/low-level-design"], a[href^="/dsa"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('observed-progress-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: testInfo.outputPath('observed-progress-mobile.png'), fullPage: true });
  await page.locator('.progression-plan h2').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('mobile-plan-viewport.png') });
  await page.locator('.progression-skill > summary').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('mobile-observations-viewport.png') });
});

test('exhausted catalog labels repeat practice and keeps drill completion separate', async ({ page }) => {
  const sessions = recordedAttempts(); await fixture(page, { sessions, catalog: [catalog[0]] }); await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'Practice while the catalog grows' })).toBeVisible(); await expect(page.getByText('Limited unseen-task coverage', { exact: true })).toBeVisible();
  await expect(page.getByText('cannot establish fresh-task transfer.', { exact: false }).first()).toBeVisible(); await expect(page.locator('.progression-step')).toHaveCount(3); await expect(page.getByText('Completion self-reported', { exact: false })).toBeVisible();
  await page.getByText('Review the original drill', { exact: true }).click(); await expect(page.getByText('Completion is self-report and adds no observed finding.', { exact: false })).toBeVisible();
});

test('Not observed remains missing evidence rather than a low skill finding', async ({ page }) => {
  await fixture(page, { sessions: [attempt('unobserved-attempt', '2026-10-09T12:00:00.000Z', 'Not observed')] }); await page.goto('/progress');
  await expect(page.getByRole('heading', { name: 'No usable observed findings yet' })).toBeVisible(); await expect(page.locator('.progression-skill')).toHaveCount(0); await page.getByText('Criteria marked Not observed (1)', { exact: true }).click(); await expect(page.getByText('These are missing observations, not low skill findings.', { exact: false })).toBeVisible();
});

test('unknown bookmarked goals provide a clear-selection recovery', async ({ page }) => {
  const requests = await fixture(page); await page.goto('/progress?competency=unpublished-goal'); await expect(page.locator('.progression-page').getByRole('alert')).toContainText('Choose only available practice criteria');
  await page.getByRole('button', { name: 'Clear selection and reload' }).click(); await expect(page.getByRole('heading', { name: 'Start collecting practice evidence' })).toBeVisible(); await expect(page).toHaveURL(/\/progress$/); expect(requests.at(-1)).toEqual([]);
});

test('oversized bookmarked goals are bounded before progress fetch', async ({ page }) => {
  const requests = await fixture(page); const query = new URLSearchParams(); for (let index = 0; index < 21; index++) query.append('competency', `criterion-${index}`);
  await page.goto(`/progress?${query}`); await expect(page.locator('.progression-page').getByRole('alert')).toContainText('no more than 20 practice goals'); expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Clear selection and reload' }).click(); await expect(page.getByRole('heading', { name: 'Start collecting practice evidence' })).toBeVisible(); expect(requests.at(-1)).toEqual([]);
});

test('catalog errors do not hide the recorded profile and empty catalogs invent no links', async ({ page }) => {
  await fixture(page, { sessions: recordedAttempts(), catalogFailure: true }); await page.goto('/progress'); await expect(page.getByRole('heading', { name: 'Your next practice steps' })).toBeVisible(); await page.getByText('Choose practice goals (optional)', { exact: true }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Goal choices could not load' })).toBeVisible(); await expect(page.locator('.progression-skill')).toHaveCount(1);
  await fixture(page, { catalog: [] }); await page.goto('/progress'); await expect(page.getByText('No authored practice step is available yet.', { exact: false })).toBeVisible(); await expect(page.locator('.progression-step')).toHaveCount(0); await expect(page.getByRole('link', { name: 'Set up practice', exact: true })).toHaveCount(0);
});

test('configured local progress API serves cold start and selected authored goals', async ({ page }, testInfo) => {
  // Actual app integration check: local development identity and read-only
  // progress/catalog APIs. No attempt, runner job, provider call, or charge.
  const auth = await page.request.get('/api/auth/session'); const identity = await auth.json();
  test.skip(identity.authMode !== 'local', 'Actual progress smoke requires the configured local development identity.');
  await page.goto('/progress'); await expect(page.getByRole('heading', { name: 'Start collecting practice evidence' })).toBeVisible();
  await expect(page.locator('.progression-summary')).toContainText('Saved attempts');
  await page.getByText('Choose practice goals (optional)', { exact: true }).click(); await page.getByRole('checkbox').first().check();
  const response = page.waitForResponse(item => item.url().includes('/api/interview-practice/progress?competency=') && item.request().method() === 'GET');
  await page.getByRole('button', { name: 'Apply goals' }).click(); const result = await response; expect(result.status()).toBe(200);
  const data = await result.json(); expect(data.studyPlan.selectedCompetencies).toHaveLength(1); expect(data.studyPlan.status).toBe('cold-start'); expect(data.studyPlan.steps.length).toBeLessThanOrEqual(3);
  await expect(page).toHaveURL(/competency=/); await expect(page.getByRole('heading', { name: 'Start collecting practice evidence' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('actual-local-selected-goal.png'), fullPage: true });
});


test('configured lesson opens separately by keyboard without a referrer or practice data', async ({ page, context }, testInfo) => {
  const destinations: { url: string; referrer: string | undefined }[] = [];
  await context.route('https://foundry.example/**', route => {
    destinations.push({ url: route.request().url(), referrer: route.request().headers()['referer'] });
    return route.fulfill({ contentType: 'text/html', body: '<title>Foundry destination fixture</title><h1>Related lesson fixture</h1>' });
  });
  await fixture(page, { sessions: recordedAttempts(), lessonOrigin: 'https://foundry.example' }); await page.goto('/progress');
  const link = page.getByRole('link', { name: 'Open Foundry lesson' }); await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://foundry.example/low-level-design/lessons/state-lifecycle-errors');
  await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', 'noopener noreferrer'); await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  await link.focus(); await expect(link).toBeFocused(); const opened = context.waitForEvent('page'); await page.keyboard.press('Enter'); const popup = await opened;
  await expect(popup.getByRole('heading', { name: 'Related lesson fixture' })).toBeVisible();
  expect(destinations).toEqual([{ url: 'https://foundry.example/low-level-design/lessons/state-lifecycle-errors', referrer: undefined }]);
  await popup.close(); await expect(page).toHaveURL(/\/progress$/);
  await page.setViewportSize({ width: 390, height: 844 }); await link.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('configured-foundry-lesson-mobile.png') });
});
