import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

const id = '16210cb0-3c57-4ca9-9b1c-c70244365b34';
const now = new Date().toISOString();
const capabilities = { ai: false, coaching: false, runner: false, voice: false, billing: false, accounts: true };
const scenario: PublicScenario = {
  id: 'recovery-fixture', version: '1.0.0', title: 'Recovery contract fixture', summary: 'Explicit browser fixture, without execution.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Fixture' },
  stages: ['inspect', 'extend', 'verify'].map(stage => ({ id: stage, title: stage, brief: `Current fixture checkpoint: ${stage}.`, requirements: ['Explain the recorded evidence.'] })),
  rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain choices.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [], rights: 'Original test fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 },
};
function attempt(): SessionView {
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, accommodations: [] }, files: scenario.files, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' };
}
async function fixture(page: Page, session = attempt(), ai = false) {
  // Every API is intercepted. These are transport/UX contract checks, not
  // provider, runner, admission, or authorization qualification.
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: `Unexpected fixture request: ${route.request().url()}` } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'recovery-fixture-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/capabilities', route => route.fulfill({ json: { capabilities } }));
  await page.route('**/api/interview-practice/sessions', route => route.fulfill({ json: { sessions: [session] } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [scenario], capabilities } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities: { ...capabilities, ai } } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  return session;
}
async function openWorkspace(page: Page) { await page.goto(`/interview-practice/${id}`); await expect(page.getByRole('button', { name: 'Next checkpoint', exact: true })).toBeVisible(); }

test('an interrupted start freezes its body and keeps its key through a later rate limit', async ({ page }, testInfo) => {
  const session = await fixture(page); const bodies: string[] = [];
  await page.route('**/api/interview-practice/sessions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { sessions: [session] } });
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) return route.abort('failed'); // The fixture admission committed before the response was lost.
    if (bodies.length === 2) return route.fulfill({ status: 429, json: { error: { message: 'Fixture retry is temporarily rate limited.' } } });
    return route.fulfill({ status: 201, json: { session } });
  });
  await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true }).selectOption('60');
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 }); await dialog.getByRole('button', { name: 'Retry start', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('pending-start-mobile.png') });
  await page.reload(); await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled(); await expect(dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true })).toHaveValue('60'); expect(bodies).toHaveLength(1);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Retry start', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('temporarily rate limited');
  await expect(dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true })).toBeDisabled();
  await dialog.getByRole('link', { name: 'Review saved attempts', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Practice history', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Practice', exact: true }).click(); await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Retry start', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`);
  expect(bodies).toHaveLength(3); expect(bodies[1]).toBe(bodies[0]); expect(bodies[2]).toBe(bodies[0]); expect(JSON.parse(bodies[0]).targetMinutes).toBe(60);
});

test('a definitive initial rejection unlocks setup and changed settings receive a new key', async ({ page }) => {
  const session = await fixture(page); const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/interview-practice/sessions', route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill(bodies.length === 1 ? { status: 400, json: { error: { message: 'Fixture rejected the initial configuration.' } } } : { status: 201, json: { session } });
  });
  await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' }); await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('rejected the initial'); await expect(dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true })).toBeEnabled();
  await dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true }).selectOption('60'); await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`);
  expect(bodies[1].requestId).not.toBe(bodies[0].requestId); expect(bodies[1].targetMinutes).toBe(60);
});

test('hint retry replays the same wire body after polling observes a committed action', async ({ page }, testInfo) => {
  const session = await fixture(page); const bodies: string[] = []; const recorded = new Set<string>();
  await page.route(`**/api/interview-practice/sessions/${id}/hints`, route => {
    const body = route.request().postData()!; const key = JSON.parse(body).requestId; bodies.push(body);
    if (!recorded.has(key)) { recorded.add(key); session.hintsOpened++; session.revision++; }
    if (bodies.length === 1) return route.abort('failed');
    return route.fulfill({ json: { session, hint: `Fixture hint ${session.hintsOpened}` } });
  });
  await openWorkspace(page); await page.getByRole('button', { name: 'Show a hint (0 used)', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Show a hint (1 used)', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Recover hint', exact: true })).toBeVisible(); expect(bodies).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Recover hint', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('pending-action-mobile.png') });
  await page.getByRole('button', { name: 'Recover hint', exact: true }).click(); await expect(page.getByText('Fixture hint 1', { exact: true })).toBeVisible();
  expect(bodies[1]).toBe(bodies[0]); expect(session.hintsOpened).toBe(1);
  await page.getByRole('button', { name: 'Show a hint (1 used)', exact: true }).click(); await expect(page.getByText('Fixture hint 2', { exact: true })).toBeVisible();
  expect(JSON.parse(bodies[2]).requestId).not.toBe(JSON.parse(bodies[1]).requestId); expect(JSON.parse(bodies[2]).expectedRevision).toBe(2);
});

test('checkpoint retry cannot advance another stage after an acknowledgement is lost', async ({ page }) => {
  const session = await fixture(page); const bodies: string[] = []; const recorded = new Set<string>();
  await page.route(`**/api/interview-practice/sessions/${id}/commands`, route => {
    const body = route.request().postData()!; const key = JSON.parse(body).requestId; bodies.push(body);
    if (!recorded.has(key)) { recorded.add(key); session.stageId = session.stageId === 'inspect' ? 'extend' : 'verify'; session.revision++; }
    return bodies.length === 1 ? route.abort('failed') : route.fulfill({ json: { session } });
  });
  await openWorkspace(page); await page.getByRole('button', { name: 'Next checkpoint', exact: true }).click();
  await expect(page.getByText('Current fixture checkpoint: extend.', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('button', { name: 'Recover checkpoint', exact: true })).toBeVisible(); expect(bodies).toHaveLength(1);
  await page.getByRole('button', { name: 'Recover checkpoint', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover checkpoint', exact: true })).toHaveCount(0); await expect(page.locator('.workspace-notice')).toHaveCount(0);
  expect(bodies[1]).toBe(bodies[0]); expect(session.stageId).toBe('extend');
  await page.getByRole('button', { name: 'Next checkpoint', exact: true }).click(); await expect(page.getByText('Current fixture checkpoint: verify.', { exact: true })).toBeVisible();
  expect(JSON.parse(bodies[2]).requestId).not.toBe(JSON.parse(bodies[1]).requestId);
});

test('changed assistant input never reuses an interrupted request key', async ({ page }) => {
  const session = await fixture(page, attempt(), true); const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/assistant`, route => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1 ? route.abort('failed') : route.fulfill({ json: { session } });
  });
  await openWorkspace(page); await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click();
  await page.getByLabel('Ask the coding assistant', { exact: true }).fill('Explain the first approach.'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.workspace-notice').getByRole('alert')).toBeVisible(); await page.getByLabel('Ask the coding assistant', { exact: true }).fill('Explain a different approach.'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByLabel('Ask the coding assistant', { exact: true })).toHaveValue(''); expect(bodies).toHaveLength(2); expect(bodies[1].requestId).not.toBe(bodies[0].requestId); expect(bodies[1].message).not.toBe(bodies[0].message);
});

test('Escape leaves a busy support dialog open so a failed request remains recoverable', async ({ page }) => {
  await fixture(page); let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { cases: [] } });
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) { await blocked; return route.fulfill({ status: 503, json: { error: { message: 'Fixture support request interrupted. Retry.' } } }); }
    return route.fulfill({ status: 201, json: { case: { id: 'd8fc905f-d84f-435b-8dcb-046067f9fa89', sessionId: id, reportId: null, category: 'technical', message: JSON.parse(bodies[1]).message, criterionIds: [], status: 'open', revision: 1, inspectionConsent: false, supportActionsConsent: false, consentVersion: 'support-inspection-v1', consentExpiresAt: null, createdAt: now, updatedAt: now } } });
  });
  await openWorkspace(page); await page.getByText('Technical help and support permissions', { exact: true }).click(); await page.getByRole('button', { name: 'Request technical help', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Request a review', exact: true }); await dialog.getByLabel('Your concern').fill('Please help recover the saved attempt.'); await dialog.getByRole('button', { name: 'Submit review request' }).click();
  await expect(dialog.getByRole('button', { name: 'Submitting…', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); expect(await dialog.evaluate(element => (element as HTMLDialogElement).open)).toBe(true);
  release(); await expect(dialog.getByRole('alert')).toContainText('support request interrupted'); await dialog.getByRole('button', { name: 'Submit review request' }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByText('Technical help · open', { exact: true })).toBeVisible(); expect(bodies[1]).toBe(bodies[0]);
});

test('a cancelled report shows its saved state and an owner retry control', async ({ page }) => {
  const session = attempt(); session.lifecycle = 'reviewing'; session.codeFrozenSnapshotId = 'fixture-snapshot'; session.stageId = 'debrief';
  session.jobs.push({ id: 'cancelled-coach-fixture', sessionId: id, kind: 'coach', state: 'cancelled', requestId: 'original-fixture', snapshotId: 'fixture-snapshot', createdAt: now, updatedAt: now, attempt: 1, reservationSequence: 1, fencingToken: 1, leaseExpiresAt: null, cancellationRequested: true, reservedUsd: 0 });
  await fixture(page, session); let calls = 0;
  await page.route(`**/api/interview-practice/sessions/${id}/reports`, route => { calls++; expect(route.request().postDataJSON().requestId).toBeTruthy(); session.jobs[0].state = 'queued'; return route.fulfill({ json: { session, job: session.jobs[0] } }); });
  await page.goto(`/interview-practice/${id}`); await expect(page.getByText('Report preparation was cancelled. Your frozen attempt is saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry report', exact: true }).click(); await expect(page.getByText('Preparing your report from the frozen attempt…', { exact: true })).toBeVisible(); expect(calls).toBe(1);
});

test('actual local admission and hint retries recover committed responses without duplicate actions', async ({ page }) => {
  // Actual local API integration. Creation/hints do not enqueue execution or
  // inference. No Docker, model, speech, or payment endpoint is used.
  const auth = await page.request.get('/api/auth/session'); const identity = await auth.json();
  test.skip(identity.authMode !== 'local', 'Actual recovery smoke requires the local development identity.');
  const catalog = await (await page.request.get('/api/interview-practice/scenarios')).json();
  test.skip(!catalog.scenarios?.length, 'Actual recovery smoke requires open authored scenario admission.');
  const createBodies: string[] = []; const hintBodies: string[] = []; let createdId: string | undefined;
  await page.route('**/api/interview-practice/sessions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    createBodies.push(route.request().postData()!); const response = await route.fetch(); expect(response.status()).toBe(201); const result = await response.json(); createdId = result.session.id;
    return createBodies.length === 1 ? route.abort('failed') : route.fulfill({ response });
  });
  try {
    await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).first().click(); await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled(); await page.reload(); await page.getByRole('button', { name: 'Set up practice', exact: true }).first().click(); expect(createBodies).toHaveLength(1);
    await page.getByRole('button', { name: 'Retry start', exact: true }).click(); await expect(page).toHaveURL(/\/interview-practice\/[^/?]+$/); expect(createBodies).toHaveLength(2); expect(createBodies[1]).toBe(createBodies[0]);
    const list = await (await page.request.get('/api/interview-practice/sessions')).json(); expect(list.sessions.filter((item: SessionView) => item.id === createdId)).toHaveLength(1); expect(list.sessions).toHaveLength(1);
    await page.route(`**/api/interview-practice/sessions/${createdId}/hints`, async route => {
      hintBodies.push(route.request().postData()!); const response = await route.fetch(); expect(response.status()).toBe(200);
      return hintBodies.length === 1 ? route.abort('failed') : route.fulfill({ response });
    });
    await page.getByRole('button', { name: 'Show a hint (0 used)', exact: true }).click(); await expect(page.getByRole('button', { name: 'Show a hint (1 used)', exact: true })).toBeVisible(); await page.reload(); await page.getByRole('button', { name: 'Recover hint', exact: true }).click();
    await expect(page.locator('.hint')).toBeVisible(); expect(hintBodies).toHaveLength(2); expect(hintBodies[1]).toBe(hintBodies[0]);
    const saved = await (await page.request.get(`/api/interview-practice/sessions/${createdId}`)).json(); expect(saved.session.hintsOpened).toBe(1); expect(saved.session.jobs).toHaveLength(0);
  } finally { if (createdId) { const removed = await page.request.delete(`/api/interview-practice/sessions/${createdId}`, { headers: { Origin: new URL(page.url()).origin }, data: { requestId: crypto.randomUUID() } }); expect(removed.ok()).toBeTruthy(); } }
});

async function seedRecovery(page: Page) {
  await page.evaluate(({ id }) => { sessionStorage.setItem('foundry-practice-pending:recovery-fixture-owner:creation', 'PRIVATE RETRY FIXTURE'); sessionStorage.setItem(`foundry-practice-pending:recovery-fixture-owner:${encodeURIComponent(`session:${id}`)}`, 'PRIVATE RETRY FIXTURE'); localStorage.setItem(`foundry-practice-draft:${id}`, 'PRIVATE DRAFT FIXTURE'); sessionStorage.setItem('unrelated-setting', 'keep'); }, { id });
}
test('deleting practice data clears browser retry content while preserving unrelated settings', async ({ page }) => {
  await fixture(page); await page.route('**/api/account', route => { expect(route.request().postDataJSON()).toMatchObject({ confirmation: 'DELETE' }); return route.fulfill({ json: { deleted: true } }); });
  await page.goto('/settings'); await expect(page.getByRole('button', { name: 'Delete practice data', exact: true })).toBeEnabled(); await seedRecovery(page);
  await page.getByRole('button', { name: 'Delete practice data', exact: true }).click(); await page.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE'); await page.getByRole('button', { name: 'Delete Interview Lab data', exact: true }).click();
  await expect(page.getByText('Your private Interview Lab content was deleted.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => ({ pending: Object.keys(sessionStorage).filter(key => key.startsWith('foundry-practice-pending:')), drafts: Object.keys(localStorage).filter(key => key.startsWith('foundry-practice-draft:')), unrelated: sessionStorage.getItem('unrelated-setting') }))).toEqual({ pending: [], drafts: [], unrelated: 'keep' });
});
test('signing out clears browser retry content', async ({ page }) => {
  await fixture(page); await page.route('**/api/auth/logout', route => route.fulfill({ json: { message: 'Signed out.' } }));
  await page.goto('/settings'); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeEnabled(); await seedRecovery(page); await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('foundry-practice-pending:')))).toEqual([]);
});
test('deleting an attempt clears that owner-session retry record and local draft', async ({ page }) => {
  await fixture(page); await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { deleted: true } }));
  await page.goto('/history'); await expect(page.getByRole('link', { name: scenario.title, exact: true })).toBeVisible(); await seedRecovery(page);
  await page.getByRole('button', { name: `Delete ${scenario.title}`, exact: true }).click(); await page.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(page.getByRole('link', { name: scenario.title, exact: true })).toHaveCount(0);
  expect(await page.evaluate(({ id }) => ({ pending: sessionStorage.getItem(`foundry-practice-pending:recovery-fixture-owner:${encodeURIComponent(`session:${id}`)}`), draft: localStorage.getItem(`foundry-practice-draft:${id}`), unrelated: sessionStorage.getItem('unrelated-setting') }), { id })).toEqual({ pending: null, draft: null, unrelated: 'keep' });
});

test('other-account and mismatched browser records never dispatch an automatic retry', async ({ page }) => {
  await fixture(page); let posts = 0;
  await page.route('**/api/interview-practice/sessions', route => { if (route.request().method() === 'POST') posts++; return route.fulfill({ json: { sessions: [] } }); });
  await page.goto('/interview-practice');
  await page.evaluate(({ id, now }) => {
    const payload = JSON.stringify({ scenarioId: 'recovery-fixture', mode: 'practice', role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 60, aiHelp: false, voice: false, requestId: 'other-owner-original-key' });
    sessionStorage.setItem('foundry-practice-pending:another-owner:creation', JSON.stringify([['create', { payload, uncertain: true, createdAt: now }]]));
    const intent = JSON.stringify({ path: 'hints', body: {} });
    sessionStorage.setItem(`foundry-practice-pending:recovery-fixture-owner:${encodeURIComponent(`session:${id}`)}`, JSON.stringify([[intent, { payload: JSON.stringify({ action: 'finish', expectedRevision: 1, requestId: 'mismatched-private-key' }), uncertain: true, createdAt: now }]]));
  }, { id, now });
  await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Set up your session' }); await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled(); await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toHaveCount(0); expect(posts).toBe(0);
  await page.keyboard.press('Escape'); await openWorkspace(page); await expect(page.getByRole('button', { name: 'Recover hint', exact: true })).toHaveCount(0); expect(posts).toBe(0);
});
