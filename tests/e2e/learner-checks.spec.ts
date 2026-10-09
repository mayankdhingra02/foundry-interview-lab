import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView, TestRun } from '../../lib/interview-practice/types';
import { LEARNER_CHECK_POLICY as policy } from '../../lib/interview-practice/check-policy';

// Explicit HTTP fixtures exercise editing, transport and provenance UX. They
// never run Python, containers, providers, billing or the protected contracts.
const id = '68ce1d5a-b2e1-4266-b6fd-715c1812a011';
const now = new Date().toISOString();
const source = 'import unittest\n\nclass BoundaryChecks(unittest.TestCase):\n    def test_empty_input(self):\n        from main import calculate\n        self.assertEqual(calculate([]), 0)\n';
const revisedSource = source.replace('test_empty_input', 'test_empty_input_regression');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const scenario: PublicScenario = {
  id: 'learner-checks-fixture', version: '1.0.0', title: 'Regression check fixture', summary: 'Write a regression observation for an original task.', durationMinutes: 45, level: 'Mid-level', tags: ['verification'], language: 'python', files: { 'main.py': 'def calculate(items):\n    return sum(items)\n' },
  stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect the saved implementation.', requirements: ['Preserve the public interface.'] }], rubric: [{ id: 'verification', name: 'Verification', description: 'Use recorded evidence.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }],
  tests: [{ id: 'public-contract', title: 'Authored public contract', visible: true, source: '# Public synthetic contract', timeoutSeconds: 3 }, { id: 'protected-contract', title: 'Protected contract', visible: false, timeoutSeconds: 3 }], drills: [], rights: 'Original browser fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 },
};
function attempt(): SessionView {
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario: structuredClone(scenario), mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['verification'], targetMinutes: 45, aiHelp: false, voice: false, accommodations: [] }, files: { ...scenario.files }, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' };
}
function recordedRun(session: SessionView, learner: boolean, status: 'passed' | 'failed' | 'error' = 'passed'): TestRun {
  return { id: `fixture-run-${session.runs.length + 1}`, jobId: 'fixture-job', snapshotId: 'fixture-snapshot', snapshotSha256: sha(JSON.stringify(session.files)), createdAt: now, testSuiteDigest: sha(learner ? 'learner-suite' : 'authored-suite'), status: 'completed', command: 'Fixture evidence only; no Python executed', stdout: '', stderr: '', exitCode: status === 'passed' ? 0 : 1, durationMs: 10, tests: learner ? [{ id: policy.testId, title: 'Learner-authored regression check', status, ...(status === 'error' ? { detail: 'No unittest checks were discovered.' } : {}) }] : [{ id: 'public-contract', title: 'Authored public contract', status }, { id: 'protected-contract', title: 'Protected contract', status }], ...(learner ? { learnerCheck: { workspacePolicyVersion: 1, executionPolicyVersion: 1, path: policy.path, sourceSha256: sha(session.files[policy.path]) } } : {}) };
}
async function fixture(page: Page, session = attempt(), runner = true) {
  const saves: Record<string, unknown>[] = []; const runs: string[] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture API request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'learner-checks-fixture-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario: session.scenario, capabilities: { ai: false, coaching: false, runner, voice: false, billing: false, accounts: true } } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => { const body = route.request().postDataJSON(); saves.push(body); if (Buffer.byteLength(body.files[policy.path] ?? '') > policy.maxSourceBytes) return route.fulfill({ status: 400, json: { error: { message: 'Learner check source exceeds its byte bound.' } } }); session.files = body.files; session.revision++; return route.fulfill({ json: { session } }); });
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { runs.push(route.request().postData()!); session.runs.push(recordedRun(session, route.request().postDataJSON().selection === 'learner')); session.revision++; return route.fulfill({ json: { session } }); });
  return { session, saves, runs };
}
async function openPanel(page: Page) { await page.goto(`/interview-practice/${id}`); await page.locator('.learner-checks-panel > summary').click(); return page.locator('.learner-checks-panel'); }

test('optional source requires learner action, is keyboard reachable, and a failing starter never runs automatically', async ({ page }, testInfo) => {
  const data = await fixture(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/interview-practice/${id}`); const summary = page.locator('.learner-checks-panel > summary'); await summary.focus(); await page.keyboard.press('Enter'); const panel = page.locator('.learner-checks-panel');
  await expect(panel).toContainText('Optional file not added. Nothing runs automatically.'); expect(data.saves).toHaveLength(0); expect(data.runs).toHaveLength(0); expect(data.session.files).not.toHaveProperty(policy.path);
  await page.keyboard.press('Tab'); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(panel.getByRole('button', { name: 'Insert failing unittest starter', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(panel.getByLabel('Your regression-check source', { exact: true })).toHaveValue(/self\.fail\(/); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toBeFocused(); await expect.poll(() => data.saves.length).toBe(1); expect(data.runs).toHaveLength(0); expect(data.session.files[policy.path]).toContain('Replace this placeholder with a regression assertion.');
  await panel.getByLabel('Your regression-check source').scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath('learner-check-source-mobile.png'), fullPage: true });
});

test('explicit learner run saves the full workspace first and binds its result to the saved source', async ({ page }) => {
  const data = await fixture(page); const order: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => { order.push('save'); return route.fallback(); }); await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { order.push('run'); return route.fallback(); });
  const panel = await openPanel(page); await page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true }).fill(scenario.files['main.py'] + '# Manual code change\n'); await panel.getByLabel('Your regression-check source', { exact: true }).fill(source);
  await expect(panel).toContainText('Unsaved regression-check changes'); await panel.getByRole('button', { name: 'Run my regression check', exact: true }).click(); const result = page.getByRole('region', { name: 'Learner-authored check result', exact: true });
  await expect(result).toContainText('1 / 1 learner-authored checks passed'); await expect(result).toContainText('does not establish that authored or protected scenario checks passed'); await expect(panel).toContainText('Check source matches the saved workspace.'); await expect(panel).toContainText('The check source matches that run. Other implementation files may have changed.');
  expect(order).toEqual(['save', 'run']); expect(data.saves[0]).toMatchObject({ files: { ...scenario.files, 'main.py': scenario.files['main.py'] + '# Manual code change\n', [policy.path]: source } }); expect(JSON.parse(data.runs[0])).toMatchObject({ selection: 'learner', expectedRevision: 2 }); expect(JSON.parse(data.runs[0])).not.toHaveProperty('source'); expect(data.session.runs[0].learnerCheck?.sourceSha256).toBe(sha(source)); await expect(page.getByText('No authored run is recorded for this attempt.', { exact: true })).toBeVisible();
});

test('default run remains authored while a separate learner pass preserves earlier authored failures', async ({ page }) => {
  const initial = attempt(); initial.files[policy.path] = source; const data = await fixture(page, initial);
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { data.runs.push(route.request().postData()!); const learner = route.request().postDataJSON().selection === 'learner'; data.session.runs.push(recordedRun(data.session, learner, learner ? 'passed' : 'failed')); data.session.revision++; return route.fulfill({ json: { session: data.session } }); });
  const panel = await openPanel(page); await page.getByRole('button', { name: 'Run tests', exact: true }).click(); await expect(page.getByRole('region', { name: 'Authored scenario check result', exact: true })).toContainText('0 / 2 authored checks passed'); expect(JSON.parse(data.runs[0])).not.toHaveProperty('selection');
  await panel.getByRole('button', { name: 'Run my regression check', exact: true }).click(); await expect(page.getByRole('region', { name: 'Learner-authored check result', exact: true })).toContainText('1 / 1 learner-authored checks passed'); await page.locator('.previous-authored-run > summary').click(); await expect(page.getByRole('region', { name: 'Authored scenario check result', exact: true })).toContainText('0 / 2 authored checks passed'); expect(data.session.runs).toHaveLength(2); expect(JSON.parse(data.runs[1]).selection).toBe('learner');
});

test('zero unittest discovery is a visible error and output text cannot create an authored pass claim', async ({ page }) => {
  const initial = attempt(); initial.files[policy.path] = 'print("all tests passed")\n'; const data = await fixture(page, initial);
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { data.runs.push(route.request().postData()!); const run = recordedRun(data.session, true, 'error'); run.stdout = '</pre><script>window.checkOutputExecuted=true</script>all tests passed'; data.session.runs.push(run); data.session.revision++; return route.fulfill({ json: { session: data.session } }); });
  const panel = await openPanel(page); await panel.getByRole('button', { name: 'Run my regression check', exact: true }).click(); const result = page.getByRole('region', { name: 'Learner-authored check result', exact: true }); await expect(result.getByRole('alert')).toContainText('No unittest checks were discovered.'); await expect(result).toContainText('0 / 1 learner-authored checks passed'); await result.getByText('Execution logs', { exact: true }).click(); await expect(result.locator('pre').filter({ hasText: '</pre><script>' })).toContainText('</pre><script>'); await expect(result.locator('script')).toHaveCount(0); expect(await page.evaluate(() => Object.hasOwn(window, 'checkOutputExecuted'))).toBe(false); await expect(page.getByRole('region', { name: 'Authored scenario check result', exact: true })).toHaveCount(0);
});

test('runner-unconfigured state permits source saving and never suggests execution', async ({ page }) => {
  const data = await fixture(page, attempt(), false); const panel = await openPanel(page); await panel.getByLabel('Your regression-check source', { exact: true }).fill(source); await panel.getByRole('button', { name: 'Save check source', exact: true }).click(); await expect(panel).toContainText('Saving remains available. A configured code runner is required to verify this check.'); await expect(panel.getByRole('button', { name: 'Run my regression check', exact: true })).toBeDisabled(); expect(data.session.files[policy.path]).toBe(source); expect(data.runs).toHaveLength(0);
});

for (const state of ['frozen', 'paused', 'pending'] as const) {
  test(`learner source and run controls are read only when ${state}`, async ({ page }) => {
    const initial = attempt(); initial.files[policy.path] = source;
    if (state === 'frozen') { initial.codeFrozenSnapshotId = 'frozen-snapshot'; initial.stageId = 'debrief'; } else if (state === 'paused') initial.lifecycle = 'paused'; else initial.jobs.push({ id: 'queued-run', sessionId: id, kind: 'run', state: 'queued', requestId: 'queued-request', snapshotId: 'queued-snapshot', createdAt: now, updatedAt: now, attempt: 0, reservationSequence: 1, fencingToken: 0, leaseExpiresAt: null, cancellationRequested: false, reservedUsd: 0 });
    const data = await fixture(page, initial); const panel = await openPanel(page); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toHaveAttribute('readonly', ''); await expect(panel.getByRole('button', { name: 'Save check source', exact: true })).toBeDisabled(); await expect(panel.getByRole('button', { name: 'Run my regression check', exact: true })).toBeDisabled(); expect(data.saves).toHaveLength(0); expect(data.runs).toHaveLength(0);
  });
}

test('lost learner-run acknowledgement replays exact selection and does not retarget a later edited source', async ({ page }) => {
  const initial = attempt(); initial.files[policy.path] = source; const data = await fixture(page, initial); let admitted: SessionView | undefined;
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { data.runs.push(route.request().postData()!); if (!admitted) { data.session.runs.push(recordedRun(data.session, true)); data.session.revision++; admitted = structuredClone(data.session); return route.abort('failed'); } return route.fulfill({ json: { session: admitted } }); });
  let panel = await openPanel(page); await panel.getByRole('button', { name: 'Run my regression check', exact: true }).click(); await expect(panel.getByRole('alert')).toBeVisible(); await page.reload(); await expect(page.getByRole('button', { name: 'Recover learner checks', exact: true })).toBeVisible(); expect(data.runs).toHaveLength(1); await page.locator('.learner-checks-panel > summary').click(); panel = page.locator('.learner-checks-panel'); await expect(panel.getByRole('button', { name: 'Run my regression check', exact: true })).toBeDisabled(); await panel.getByLabel('Your regression-check source', { exact: true }).fill(revisedSource); await panel.getByRole('button', { name: 'Save check source', exact: true }).click(); await expect(panel).toContainText('The current check source differs from that run.'); await page.getByRole('button', { name: 'Recover learner checks', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover learner checks', exact: true })).toHaveCount(0);
  expect(data.runs).toHaveLength(2); expect(data.runs[1]).toBe(data.runs[0]); expect(JSON.parse(data.runs[0]).selection).toBe('learner'); expect(data.session.runs).toHaveLength(1); expect(data.session.runs[0].learnerCheck?.sourceSha256).toBe(sha(source)); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toHaveValue(revisedSource); await expect(panel).toContainText('The current check source differs from that run.');
});

test('UTF-8 bounds keep oversized source locally and disable execution without truncation', async ({ page }) => {
  const data = await fixture(page); const panel = await openPanel(page); const oversized = '🙂'.repeat(2001); await panel.getByLabel('Your regression-check source', { exact: true }).fill(oversized); await expect(panel.getByRole('alert')).toContainText('exceeds 8,000 UTF-8 bytes'); await expect(panel).toContainText('8,004 / 8,000 UTF-8 bytes'); await expect(panel.getByRole('button', { name: 'Run my regression check', exact: true })).toBeDisabled(); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toHaveValue(oversized); expect(data.runs).toHaveLength(0); expect(await page.evaluate(({ id, path }) => JSON.parse(localStorage.getItem(`foundry-practice-draft:${id}`)!).files[path], { id, path: policy.path })).toBe(oversized);
});

test('source-save conflict stays visible and prevents a learner run while retaining manual work', async ({ page }) => {
  const data = await fixture(page); await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => route.fulfill({ status: 409, json: { error: { message: 'Saved code changed elsewhere. Your local check draft was retained.' } } })); const panel = await openPanel(page); await panel.getByLabel('Your regression-check source', { exact: true }).fill(source); await panel.getByRole('button', { name: 'Run my regression check', exact: true }).click(); await expect(panel.getByRole('alert')).toContainText('local check draft was retained'); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toHaveValue(source); expect(data.runs).toHaveLength(0); expect(data.session.files).not.toHaveProperty(policy.path);
});

test('an authored package using the reserved slot keeps its original meaning', async ({ page }) => {
  const initial = attempt(); initial.scenario.files[policy.path] = '# Original authored reserved file\n'; initial.files[policy.path] = initial.scenario.files[policy.path]; const data = await fixture(page, initial); const panel = await openPanel(page); await expect(panel).toContainText('Its original files and contracts are preserved'); await expect(panel.getByLabel('Your regression-check source', { exact: true })).toHaveCount(0); await expect(panel.getByRole('button', { name: 'Run my regression check', exact: true })).toHaveCount(0); expect(data.session.files[policy.path]).toBe('# Original authored reserved file\n'); expect(data.runs).toHaveLength(0);
});

test('completed review keeps learner result origin and saved check source readable', async ({ page }) => {
  const initial = attempt(); initial.files[policy.path] = source; initial.runs.push(recordedRun(initial, true)); initial.codeFrozenSnapshotId = 'frozen-snapshot'; initial.stageId = 'debrief'; initial.lifecycle = 'completed'; initial.reports = [{ id: 'saved-report', generationId: 'saved-generation', createdAt: now, model: 'authored-observation-only', promptVersion: 'fixture-v1', rubricVersion: '1.0.0', evidenceDigest: 'a'.repeat(64), evidence: [], overview: 'No assessment was produced.', rubric: [{ criterionId: 'verification', level: 'Not observed', feedback: 'No assessed evidence.', evidenceIds: [], confidence: 'low' }], nextPractice: [] }]; await fixture(page, initial); await page.goto(`/interview-practice/${id}`); await page.getByText('View saved workspace and conversation', { exact: true }).click(); await expect(page.getByRole('region', { name: 'Learner-authored check result', exact: true })).toContainText('does not establish that authored or protected scenario checks passed'); await page.locator('.saved-attempt details').filter({ has: page.locator('summary', { hasText: policy.path }) }).locator('summary').click(); await expect(page.locator('.saved-attempt pre').filter({ hasText: 'BoundaryChecks' })).toHaveText(source);
});
