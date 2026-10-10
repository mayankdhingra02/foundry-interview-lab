import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

// Browser contract fixtures only: all APIs intercepted, no runner/model/voice calls.
const id = '5667d0bb-7b1e-46a4-9e23-f5e66a283d73', owner = 'timing-browser-owner';
const caps = { ai: false, coaching: false, runner: false, voice: true, billing: false, accounts: true };
const scenario: PublicScenario = { id: 'timing-fixture', version: '1.0.0', title: 'Advisory timing fixture', summary: 'Original synthetic browser contract fixture.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Saved fixture work\n' }, stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect the saved work.', requirements: ['Explain the boundary.'] }], rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain a choice.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [], rights: 'Synthetic browser fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 } };
function attempt(): SessionView {
  const now = new Date().toISOString();
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 60, originalTargetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' }, aiHelp: false, voice: false, accommodations: [] }, files: scenario.files, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' };
}
async function fixture(page: Page, session = attempt()) {
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected synthetic fixture API request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: owner, local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [scenario], capabilities: caps } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities: caps } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  return session;
}

test('setup preserves typed choices and the original admission key after a lost response and reload', async ({ page }, testInfo) => {
  const session = await fixture(page), bodies: string[] = [];
  await page.route('**/api/interview-practice/sessions', route => {
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) return route.abort('failed');
    return route.fulfill({ status: 201, json: { session } });
  });
  await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true }).selectOption('45');
  await dialog.getByRole('combobox', { name: 'Extra setup time', exact: true }).selectOption('extra-30');
  await dialog.getByRole('combobox', { name: 'Participation preference', exact: true }).selectOption('written-only');
  await expect(dialog.getByRole('combobox', { name: 'Conversation', exact: true })).toHaveValue('text');
  await expect(dialog.getByRole('option', { name: 'Voice', exact: true })).toHaveJSProperty('disabled', true);
  await expect(dialog.getByText('Your advisory target is 75 minutes.', { exact: false })).toBeVisible();
  await dialog.screenshot({ path: testInfo.outputPath('setup-timing-desktop.png') });
  await dialog.getByRole('button', { name: 'Start session', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('setup-actions-desktop.png') });
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry start', exact: true })).toBeEnabled();
  await page.reload(); await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await expect(dialog.getByRole('combobox', { name: 'Extra setup time', exact: true })).toHaveValue('extra-30');
  await expect(dialog.getByRole('combobox', { name: 'Participation preference', exact: true })).toHaveValue('written-only');
  await expect(dialog.getByRole('combobox', { name: 'Target duration (advisory)', exact: true })).toHaveValue('45');
  await dialog.getByRole('button', { name: 'Retry start', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0])).toMatchObject({ targetMinutes: 75, practiceConditions: { timing: 'extra-30', participation: 'written-only' }, voice: false });
});

test('an interrupted extension reloads and recovers the same request once without replacing saved work', async ({ page }, testInfo) => {
  const session = await fixture(page), bodies: string[] = [], files = structuredClone(session.files);
  await page.route(`**/api/interview-practice/sessions/${id}/timing`, route => {
    bodies.push(route.request().postData()!);
    if (bodies.length === 1) { session.configuration.targetMinutes = 90; session.revision = 2; return route.abort('failed'); }
    return route.fulfill({ json: { session } });
  });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('button', { name: 'Advisory time: 60 minutes', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Advisory time', exact: true });
  await dialog.getByRole('combobox', { name: 'Add time', exact: true }).selectOption('30');
  await dialog.screenshot({ path: testInfo.outputPath('extension-desktop.png') });
  await dialog.getByRole('button', { name: 'Add advisory time', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Add advisory time', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await page.reload();
  await expect(page.getByRole('button', { name: 'Advisory time: 90 minutes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Advisory time: 90 minutes', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Advisory time', exact: true });
  await expect(dialog.getByText('An extension is waiting for recovery.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add advisory time', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Recover advisory time', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover advisory time', exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
  expect(JSON.parse(bodies[0])).toMatchObject({ additionalMinutes: 30, expectedRevision: 1 });
  expect(session.configuration.targetMinutes).toBe(90); expect(session.configuration.originalTargetMinutes).toBe(60); expect(session.files).toEqual(files);
});

test('mobile setup and timing controls remain usable and advisory cap leaves the saved attempt active', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = attempt(); session.configuration.targetMinutes = 180; await fixture(page, session);
  await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await dialog.getByRole('combobox', { name: 'Extra setup time', exact: true }).scrollIntoViewIfNeeded();
  await dialog.getByRole('combobox', { name: 'Extra setup time', exact: true }).selectOption('extra-15');
  await page.screenshot({ path: testInfo.outputPath('setup-timing-mobile.png') });
  await dialog.getByRole('button', { name: 'Start session', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('setup-actions-mobile.png') });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(`/interview-practice/${id}`);
  const control = page.getByRole('button', { name: 'Advisory time: 180 minutes', exact: true }); await expect(control).toBeVisible();
  await control.focus(); await page.keyboard.press('Enter');
  dialog = page.getByRole('dialog', { name: 'Advisory time', exact: true });
  await expect(dialog.getByText('You can keep working and saving.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add advisory time', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('extension-mobile.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(control).toBeFocused();
  await expect(page.getByRole('button', { name: 'Finish coding', exact: true })).toBeEnabled(); expect(session.lifecycle).toBe('active');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the extension saves dirty code first and preserves the newly acknowledged files', async ({ page }) => {
  const session = await fixture(page), operations: string[] = [], authored = '# learner draft preserved before extension\n';
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => {
    operations.push('save'); const body = route.request().postDataJSON(); session.files = body.files; session.revision++;
    return route.fulfill({ json: { session } });
  });
  await page.route(`**/api/interview-practice/sessions/${id}/timing`, route => {
    operations.push('timing'); const body = route.request().postDataJSON(); expect(body.expectedRevision).toBe(2);
    session.configuration.targetMinutes += body.additionalMinutes; session.revision++;
    return route.fulfill({ json: { session } });
  });
  await page.goto(`/interview-practice/${id}`);
  await page.locator('#code-editor').fill(authored);
  await page.getByRole('button', { name: 'Advisory time: 60 minutes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Advisory time', exact: true });
  await dialog.getByRole('button', { name: 'Add advisory time', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.locator('#code-editor')).toHaveValue(authored);
  expect(operations).toEqual(['save', 'timing']); expect(session.files['main.py']).toBe(authored);
});
