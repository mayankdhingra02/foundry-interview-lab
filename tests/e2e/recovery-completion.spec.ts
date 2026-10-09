import { expect, test, type Page } from '@playwright/test';
import type { JobKind, JobView, PublicScenario, SessionView } from '../../lib/interview-practice/types';

// Explicit browser contract fixtures. All provider/runner APIs are intercepted.
const id = '1ed67c06-1768-42b5-8a4f-506fd39614b7';
const owner = 'completion-fixture-owner';
const now = new Date().toISOString();
const caps = { ai: true, coaching: false, runner: false, voice: false, billing: false, accounts: true };
const scenario: PublicScenario = { id: 'completion-fixture', version: '1.0.0', title: 'Recovery completion fixture', summary: 'Explicit frontend contract fixture.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Fixture' }, stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect the saved task.', requirements: ['Explain evidence.'] }], rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain decisions.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [], rights: 'Test fixture only.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 } };
function attempt(): SessionView { return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, accommodations: [] }, files: scenario.files, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' }; }
function job(kind: JobKind): JobView { return { id: `${kind}-fixture-job`, sessionId: id, kind, state: 'running', requestId: 'original-request-fixture', snapshotId: 'snapshot-fixture', createdAt: now, updatedAt: now, attempt: 1, reservationSequence: 1, fencingToken: 1, leaseExpiresAt: null, cancellationRequested: false, reservedUsd: 0.01 }; }
function started(session: SessionView, requestId: string) { session.events.push({ id: 'started-fixture', sessionId: id, sequence: 1, schemaVersion: 1, occurredAt: now, recordedAt: now, source: 'learner', requestId, type: 'session.started', payload: { scenarioId: scenario.id, scenarioVersion: scenario.version, mode: 'practice' } }); }
async function fixture(page: Page, session = attempt()) {
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture API request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: owner, local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [scenario], capabilities: caps } }));
  await page.route('**/api/interview-practice/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities: caps } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  return session;
}
async function seedCreation(page: Page, requestId: string) {
  await page.evaluate(({ owner, now, scenarioId, title, requestId }) => { const payload = JSON.stringify({ scenarioId, mode: 'practice', role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, voice: false, requestId }); sessionStorage.setItem(`foundry-practice-pending:${owner}:creation`, JSON.stringify([['create', { payload, uncertain: true, createdAt: now, title, scenarioVersion: '1.0.0' }]])); }, { owner, now, scenarioId: scenario.id, title: scenario.title, requestId });
}
const pendingCreation = (page: Page) => page.evaluate(owner => sessionStorage.getItem(`foundry-practice-pending:${owner}:creation`), owner);

test('owned History reconciles only the exact session.started request key', async ({ page }) => {
  const session = attempt(); started(session, 'confirmed-admission-key'); await fixture(page, session); await page.goto('/interview-practice'); await seedCreation(page, 'confirmed-admission-key'); await page.goto('/history');
  await expect(page.getByText('Your interrupted start was confirmed.', { exact: false })).toBeVisible(); expect(await pendingCreation(page)).toBeNull();
  await seedCreation(page, 'different-uncertain-key'); await page.reload(); await expect(page.getByRole('link', { name: scenario.title, exact: true })).toBeVisible(); expect(await pendingCreation(page)).not.toBeNull();
});

test('confirmed deletion reconciles its matching creation retry immediately before DELETE', async ({ page }) => {
  const session = attempt(); started(session, 'confirmed-delete-admission'); await fixture(page, session); let calls = 0;
  await page.route(`**/api/interview-practice/sessions/${id}`, async route => { expect(route.request().method()).toBe('DELETE'); expect(await pendingCreation(page)).toBeNull(); calls++; return route.fulfill({ json: { deleted: true } }); });
  await page.goto('/history'); await expect(page.getByRole('link', { name: scenario.title, exact: true })).toBeVisible(); await seedCreation(page, 'confirmed-delete-admission');
  await page.getByRole('button', { name: `Delete ${scenario.title}`, exact: true }).click(); await page.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(page.getByRole('link', { name: scenario.title, exact: true })).toHaveCount(0); expect(calls).toBe(1);
});

test('a deleted admission marker clears the old retry and waits for an explicit fresh start', async ({ page }) => {
  const session = await fixture(page); const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/interview-practice/sessions', route => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.abort('failed');
    if (bodies.length === 2) return route.fulfill({ status: 410, json: { error: { code: 'request_deleted', message: 'The original attempt was deleted. Start a new attempt explicitly.' } } });
    return route.fulfill({ status: 201, json: { session } });
  });
  await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Set up your session' }); await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await dialog.getByRole('button', { name: 'Retry start', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('original attempt was deleted'); await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled(); await expect(dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true })).toBeEnabled(); expect(await pendingCreation(page)).toBeNull(); expect(bodies).toHaveLength(2); expect(bodies[1].requestId).toBe(bodies[0].requestId);
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`); expect(bodies[2].requestId).not.toBe(bodies[1].requestId);
});

test('a deleted action marker clears only its confirmed pending action', async ({ page }) => {
  await fixture(page); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/hints`, route => { bodies.push(route.request().postData()!); return bodies.length === 1 ? route.abort('failed') : route.fulfill({ status: 410, json: { error: { code: 'request_deleted', message: 'This attempt was deleted. Review History.' } } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('button', { name: 'Show a hint (0 used)', exact: true }).click(); await page.getByRole('button', { name: 'Recover hint', exact: true }).click();
  await expect(page.locator('.workspace-notice')).toContainText('attempt was deleted'); await expect(page.getByRole('button', { name: 'Recover hint', exact: true })).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]);
});

test('an unrecognized 410 keeps an interrupted admission uncertain', async ({ page }) => {
  await fixture(page); const bodies: string[] = [];
  await page.route('**/api/interview-practice/sessions', route => { bodies.push(route.request().postData()!); return route.fulfill({ status: 410, json: { error: { code: 'unrecognized_gone', message: 'Fixture gateway response without the trusted marker.' } } }); });
  await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Set up your session' }); await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled(); expect(await pendingCreation(page)).not.toBeNull(); await dialog.getByRole('button', { name: 'Retry start', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled(); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
});

test('expired setup retries require discard and a separate fresh start, including invalid and future clocks', async ({ page }, testInfo) => {
  const session = await fixture(page); const bodies: Record<string, unknown>[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/interview-practice/sessions', route => { bodies.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { session } }); });
  const clocks = [new Date(Date.now() - 31 * 86_400_000).toISOString(), 'invalid-clock', new Date(Date.now() + 86_400_000).toISOString(), null];
  for (const [index, createdAt] of clocks.entries()) {
    await page.goto('/interview-practice'); const originalKey = `expired-admission-${index}`; await seedCreation(page, originalKey);
    await page.evaluate(({ owner, createdAt }) => { const key = `foundry-practice-pending:${owner}:creation`; const rows = JSON.parse(sessionStorage.getItem(key)!); rows[0][1].createdAt = createdAt; sessionStorage.setItem(key, JSON.stringify(rows)); }, { owner, createdAt });
    await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Set up your session' });
    await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeDisabled(); await expect(dialog.getByRole('link', { name: 'Review saved attempts', exact: true })).toBeVisible();
    // Submitting the form directly also reaches the dispatch guard; a disabled
    // button alone would not establish that an old key cannot be sent.
    await dialog.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit()); await expect(dialog.getByRole('alert')).toContainText('original replay window'); expect(bodies).toHaveLength(index);
    if (index === 0) { await dialog.getByRole('button', { name: 'Discard expired retry', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('expired-setup-mobile.png') }); }
    await dialog.getByRole('button', { name: 'Discard expired retry', exact: true }).click(); await expect(dialog.getByText('Expired retry discarded. No request was sent.', { exact: false })).toBeVisible(); expect(await pendingCreation(page)).toBeNull(); expect(bodies).toHaveLength(index);
    await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled(); await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`);
    expect(bodies).toHaveLength(index + 1); expect(bodies[index].requestId).not.toBe(originalKey);
  }
});

test('expired workspace retries cannot dispatch and discarding preserves another fresh intent', async ({ page }, testInfo) => {
  const session = await fixture(page); const bodies: Record<string, unknown>[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(`**/api/interview-practice/sessions/${id}/hints`, route => { bodies.push(route.request().postDataJSON()); session.hintsOpened = 1; session.revision = 2; return route.fulfill({ json: { session, hint: 'Fresh fixture hint.' } }); });
  const clocks = [new Date(Date.now() - 31 * 86_400_000).toISOString(), 'invalid-clock', new Date(Date.now() + 86_400_000).toISOString(), null];
  for (const [index, createdAt] of clocks.entries()) {
    session.hintsOpened = 0; session.revision = 1; await page.goto(`/interview-practice/${id}`); const originalKey = `expired-hint-${index}`;
    await page.evaluate(({ owner, id, createdAt, originalKey }) => {
      const hint = JSON.stringify({ path: 'hints', body: {} }); const checkpoint = JSON.stringify({ path: 'commands', body: { action: 'advance' } });
      sessionStorage.setItem(`foundry-practice-pending:${owner}:${encodeURIComponent(`session:${id}`)}`, JSON.stringify([[hint, { payload: JSON.stringify({ expectedRevision: 1, requestId: originalKey }), uncertain: true, createdAt }], [checkpoint, { payload: JSON.stringify({ action: 'advance', expectedRevision: 1, requestId: 'fresh-checkpoint-intent' }), uncertain: true, createdAt: new Date().toISOString() }]]));
    }, { owner, id, createdAt, originalKey });
    await page.reload(); await expect(page.getByRole('button', { name: 'Recover hint', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Recover checkpoint', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Show a hint (0 used)', exact: true }).click(); await expect(page.locator('.workspace-notice')).toContainText('original replay window'); expect(bodies).toHaveLength(index);
    if (index === 0) { await page.screenshot({ path: testInfo.outputPath('expired-workspace-mobile.png') }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
    await page.getByRole('button', { name: 'Discard expired retry for hint', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover hint', exact: true })).toHaveCount(0); await expect(page.getByText('Expired retry discarded. No request was sent.', { exact: false })).toBeVisible(); expect(bodies).toHaveLength(index);
    const remaining = await page.evaluate(({ owner, id }) => JSON.parse(sessionStorage.getItem(`foundry-practice-pending:${owner}:${encodeURIComponent(`session:${id}`)}`)!), { owner, id }); expect(remaining).toHaveLength(1); expect(JSON.parse(remaining[0][1].payload).requestId).toBe('fresh-checkpoint-intent');
    await page.getByRole('button', { name: 'Show a hint (0 used)', exact: true }).click(); await expect(page.getByText('Fresh fixture hint.', { exact: true })).toBeVisible(); expect(bodies).toHaveLength(index + 1); expect(bodies[index].requestId).not.toBe(originalKey);
  }
});

for (const kind of ['assistant', 'interviewer', 'coach'] as const) {
  test(`learner can cancel pending ${kind} work and preserve the saved attempt`, async ({ page }, testInfo) => {
    const session = attempt(); session.jobs = [job(kind)]; if (kind !== 'assistant') { session.codeFrozenSnapshotId = 'snapshot-fixture'; session.stageId = 'debrief'; } if (kind === 'coach') session.lifecycle = 'reviewing';
    await fixture(page, session); let calls = 0;
    await page.route(`**/api/interview-practice/jobs/${session.jobs[0].id}/cancel`, route => { calls++; expect(route.request().postDataJSON().requestId).toBeTruthy(); session.jobs[0].state = 'cancelled'; session.revision++; return route.fulfill({ json: { job: session.jobs[0] } }); });
    await page.goto(`/interview-practice/${id}`); const pending = page.getByRole('region', { name: 'Pending interview work' }); await expect(pending).toBeVisible(); await expect(pending).toContainText('usage limits or reserved costs can still count');
    if (kind !== 'coach') await expect(page.getByRole('button', { name: kind === 'assistant' ? 'Finish coding' : 'Final submit', exact: true })).toBeDisabled();
    if (kind === 'assistant') { await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('pending-work-mobile.png') }); }
    await pending.getByRole('button', { name: /^Cancel / }).click(); await expect(pending).toHaveCount(0); expect(calls).toBe(1); expect(session.files).toEqual(scenario.files);
    await expect(page.getByRole('button', { name: kind === 'coach' ? 'Retry report' : kind === 'assistant' ? 'Finish coding' : 'Final submit', exact: true })).toBeEnabled();
  });
}

test('an interrupted cancellation survives reload and replays the same key and body', async ({ page }) => {
  const session = attempt(); session.jobs = [job('assistant')]; await fixture(page, session); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/jobs/${session.jobs[0].id}/cancel`, route => { bodies.push(route.request().postData()!); session.jobs[0].state = 'cancelled'; session.revision = 2; return bodies.length === 1 ? route.abort('failed') : route.fulfill({ json: { job: session.jobs[0] } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('button', { name: 'Cancel coding assistance', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover cancellation', exact: true })).toBeVisible(); await page.reload();
  await page.getByRole('button', { name: 'Recover cancellation', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover cancellation', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Finish coding', exact: true })).toBeEnabled(); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
});

test('actual local History confirms a lost admission acknowledgement before deletion', async ({ page }) => {
  const auth = await (await page.request.get('/api/auth/session')).json(); test.skip(auth.authMode !== 'local', 'Actual History recovery smoke requires local development identity.');
  const catalog = await (await page.request.get('/api/interview-practice/scenarios')).json(); test.skip(!catalog.scenarios?.length, 'Actual History recovery smoke requires open scenario admission.'); let createdId: string | undefined; let createCalls = 0;
  await page.route('**/api/interview-practice/sessions', async route => { if (route.request().method() !== 'POST') return route.continue(); createCalls++; const response = await route.fetch(); expect(response.status()).toBe(201); createdId = (await response.json()).session.id; return route.abort('failed'); });
  try {
    await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).first().click(); await page.getByRole('button', { name: 'Start session', exact: true }).click(); await page.getByRole('link', { name: 'Review saved attempts', exact: true }).click();
    await expect(page.getByText('Your interrupted start was confirmed.', { exact: false })).toBeVisible(); expect(createCalls).toBe(1); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':creation') && key.startsWith('foundry-practice-pending:')))).toEqual([]);
    const row = page.locator('tr').filter({ has: page.locator(`a[href="/interview-practice/${createdId}"]`).first() }); await row.getByRole('button', { name: /^Delete / }).click(); await page.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(row).toHaveCount(0); createdId = undefined;
  } finally { if (createdId) await page.request.delete(`/api/interview-practice/sessions/${createdId}`, { headers: { Origin: new URL(page.url()).origin }, data: { requestId: crypto.randomUUID() } }); }
});
