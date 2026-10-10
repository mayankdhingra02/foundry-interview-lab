import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

// Explicit HTTP fixtures verify learner controls and transport recovery only.
// They do not qualify provider output, backend authorization, or execution.
const id = '655e47ea-13bf-4e29-bdfb-3edc20a7f9d9';
const proposalId = '4997819e-61c7-448f-9bfc-75f408c3f078';
const now = new Date().toISOString();
const originalFiles = { 'main.py': '# Original implementation\n', 'notes.md': 'Original notes\n' };
const acceptedFiles = { ...originalFiles, 'main.py': '# Accepted assistant change\n' };
const scenario: PublicScenario = { id: 'edit-undo-fixture', version: '1.0.0', title: 'Accepted edit fixture', summary: 'Original frontend contract fixture.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: originalFiles, stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect this saved task.', requirements: ['Explain your changes.'] }], rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain evidence.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [], rights: 'Original test fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 } };
function attempt(): SessionView {
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, accommodations: [] }, files: { ...acceptedFiles }, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [{ id: 'saved-assistant-message', role: 'assistant', text: 'The saved suggestion remains available.', createdAt: now }], editProposals: [{ id: proposalId, jobId: 'assistant-fixture', baseSnapshotId: 'base-snapshot-fixture', baseSha256: 'a'.repeat(64), files: { 'main.py': acceptedFiles['main.py'] }, status: 'accepted', createdAt: now, decidedAt: now }], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' };
}
async function fixture(page: Page, session = attempt(), ai = true) {
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture API request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'undo-fixture-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities: { ai, coaching: false, runner: false, voice: false, billing: false, accounts: true } } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  return session;
}
async function openEdit(page: Page) {
  await page.goto(`/interview-practice/${id}`); await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click(); await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  return page.getByRole('dialog', { name: 'Review proposed edits', exact: true });
}
function applyUndo(session: SessionView) { session.files = { ...originalFiles }; session.revision = 2; session.editProposals[0].undoneAt = now; session.editProposals[0].undoSnapshotId = 'immutable-undo-snapshot'; }

test('undo requires confirmation, restores the workspace, and preserves accepted history with AI unavailable', async ({ page }, testInfo) => {
  const session = await fixture(page, attempt(), false); const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/undo-edit`, route => { bodies.push(route.request().postDataJSON()); applyUndo(session); return route.fulfill({ json: { session } }); });
  await page.setViewportSize({ width: 390, height: 844 }); let dialog = await openEdit(page); await dialog.getByRole('button', { name: 'Undo accepted edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Undo accepted edit?', exact: true }); await expect(dialog).toContainText('original acceptance and use of assistance remain recorded'); await expect(dialog.getByRole('button', { name: 'Back to edit', exact: true })).toBeFocused(); expect(bodies).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath('undo-confirmation-mobile.png') }); await dialog.getByRole('button', { name: 'Back to edit', exact: true }).click(); expect(bodies).toHaveLength(0);
  await page.getByRole('button', { name: 'Undo accepted edit', exact: true }).click(); await page.getByRole('button', { name: 'Confirm undo accepted edit', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true })).toHaveValue(originalFiles['main.py']);
  await expect(page.getByText('accepted, later undone · 1 files', { exact: true })).toBeVisible(); await expect(page.getByText('The saved suggestion remains available.', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'AI is not configured', exact: true })).toBeVisible(); await expect(page.getByLabel('Ask the coding assistant', { exact: true })).toHaveCount(0);
  expect(bodies).toHaveLength(1); expect(bodies[0]).toMatchObject({ proposalId, expectedRevision: 1 }); expect(bodies[0].requestId).toBeTruthy(); expect(session.editProposals[0].status).toBe('accepted'); expect(session.files['notes.md']).toBe(originalFiles['notes.md']);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click(); await expect(page.getByRole('button', { name: 'Undo accepted edit', exact: true })).toBeDisabled(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Finish coding', exact: true }).click(); await expect(page.getByRole('dialog', { name: 'Finish coding?', exact: true })).toContainText('1 accepted AI edits · 1 later undone');
});

test('an already undone edit remains visible and cannot be undone again', async ({ page }) => {
  const session = attempt(); applyUndo(session); await fixture(page, session); let calls = 0;
  await page.route(`**/api/interview-practice/sessions/${id}/undo-edit`, route => { calls++; return route.fulfill({ status: 500 }); });
  const dialog = await openEdit(page); await expect(dialog).toContainText('accepted, later undone'); await expect(dialog.getByRole('button', { name: 'Undo accepted edit', exact: true })).toBeDisabled(); expect(calls).toBe(0);
});

for (const state of ['frozen', 'paused'] as const) {
  test(`undo is disabled when the workspace is ${state}`, async ({ page }) => {
    const session = attempt(); if (state === 'frozen') { session.codeFrozenSnapshotId = 'frozen-fixture'; session.stageId = 'debrief'; } else session.lifecycle = 'paused'; await fixture(page, session);
    const dialog = await openEdit(page); await expect(dialog.getByRole('button', { name: 'Undo accepted edit', exact: true })).toBeDisabled();
  });
}

test('manual changes save before a stale undo rejection and the error is visible inside the dialog', async ({ page }) => {
  const session = await fixture(page); const order: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => { const body = route.request().postDataJSON(); order.push('save'); session.files = body.files; session.revision = 2; return route.fulfill({ json: { session } }); });
  await page.route(`**/api/interview-practice/sessions/${id}/undo-edit`, route => { order.push('undo'); expect(route.request().postDataJSON().expectedRevision).toBe(2); return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Files changed after this accepted edit. Undo would overwrite newer work; your current files were preserved.' } } }); });
  await page.goto(`/interview-practice/${id}`); const editor = page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true }); await editor.fill('# My newer implementation\n');
  await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click(); await page.getByRole('button', { name: 'Review changes', exact: true }).click(); await page.getByRole('button', { name: 'Undo accepted edit', exact: true }).click(); await page.getByRole('button', { name: 'Confirm undo accepted edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Undo accepted edit?', exact: true }); await expect(dialog.getByRole('alert')).toContainText('newer work; your current files were preserved'); expect(order).toEqual(['save', 'undo']); expect(session.files['main.py']).toBe('# My newer implementation\n');
  await page.keyboard.press('Escape'); await expect(editor).toHaveValue('# My newer implementation\n'); await expect(page.getByRole('button', { name: 'Recover undo accepted edit', exact: true })).toHaveCount(0);
});

test('a busy undo dialog stays open and a lost acknowledgement recovers the original body after reload', async ({ page }) => {
  const session = await fixture(page); const bodies: string[] = []; let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/interview-practice/sessions/${id}/undo-edit`, async route => { bodies.push(route.request().postData()!); if (bodies.length === 1) { applyUndo(session); await blocked; return route.abort('failed'); } return route.fulfill({ json: { session } }); });
  await openEdit(page); await page.getByRole('button', { name: 'Undo accepted edit', exact: true }).click(); await page.getByRole('button', { name: 'Confirm undo accepted edit', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Undo accepted edit?', exact: true }); await expect(dialog.getByRole('button', { name: 'Undoing…', exact: true })).toBeDisabled(); await page.keyboard.press('Escape'); await expect(dialog).toBeVisible(); expect(await dialog.evaluate(element => (element as HTMLDialogElement).open)).toBe(true);
  release(); await expect(dialog.getByRole('alert')).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await page.reload();
  await expect(page.getByRole('button', { name: 'Recover undo accepted edit', exact: true })).toBeVisible(); expect(bodies).toHaveLength(1); await page.getByRole('button', { name: 'Recover undo accepted edit', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover undo accepted edit', exact: true })).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]); expect(session.revision).toBe(2);
  await expect(page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true })).toHaveValue(originalFiles['main.py']); await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click(); await expect(page.getByText('accepted, later undone · 1 files', { exact: true })).toBeVisible();
});

test('pending edit review still requires an explicit accept decision before undo becomes available', async ({ page }) => {
  const session = attempt(); session.editProposals[0].status = 'pending'; session.files = { ...originalFiles }; await fixture(page, session);
  await page.route(`**/api/interview-practice/sessions/${id}/edit-decisions`, route => { expect(route.request().postDataJSON()).toMatchObject({ proposalId, decision: 'accept' }); session.editProposals[0].status = 'accepted'; session.files = { ...acceptedFiles }; session.revision = 2; return route.fulfill({ json: { session } }); });
  const dialog = await openEdit(page); await expect(dialog.getByRole('button', { name: 'Undo accepted edit', exact: true })).toHaveCount(0); await dialog.getByRole('button', { name: 'Accept changes', exact: true }).click(); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: 'Review changes', exact: true }).click(); await expect(page.getByRole('button', { name: 'Undo accepted edit', exact: true })).toBeEnabled();
});
