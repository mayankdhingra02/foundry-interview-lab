import { expect, test, type Locator, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

// HTTP fixtures test confirmation, browser recovery and keyboard behavior.
// They do not qualify backend authorization, execution or provider results.
const id = 'a677ee36-d87a-444a-88e6-b36be270cad8';
const proposalId = '8a9ec00e-8239-40af-8c74-3849a0d5361b';
const owner = 'confirmation-fixture-owner';
const now = new Date().toISOString();
const capabilities = { ai: true, coaching: false, runner: false, voice: false, billing: false, accounts: true };
const scenario: PublicScenario = {
  id: 'confirmation-fixture', version: '1.0.0', title: 'Confirmation contract fixture', summary: 'Original authored browser fixture.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Saved implementation\n' },
  stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect the saved implementation.', requirements: ['Explain recorded evidence.'] }],
  rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain choices.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [], rights: 'Original test fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 },
};
function attempt(): SessionView {
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, accommodations: [] }, files: { ...scenario.files }, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' };
}
async function fixture(page: Page, session = attempt()) {
  const state = { owner, sessions: [session] };
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture API request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: state.owner, local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/capabilities', route => route.fulfill({ json: { capabilities } }));
  await page.route('**/api/interview-practice/sessions', route => route.fulfill({ json: { sessions: state.sessions } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  return { session, state };
}
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release: () => release() }; }
async function busyCannotClose(page: Page, dialog: Locator, label: string) {
  await expect(dialog.getByRole('button', { name: label, exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click(); await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(element => (element as HTMLDialogElement).open)).toBe(true);
}
async function openAccount(page: Page) { await page.goto('/settings'); await page.getByRole('button', { name: 'Delete practice data', exact: true }).click(); return page.getByRole('dialog', { name: 'Delete your Interview Lab data?', exact: true }); }
async function accountConfirm(dialog: Locator) { await dialog.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE'); await dialog.getByRole('button', { name: 'Delete Interview Lab data', exact: true }).click(); }
async function openAttempt(page: Page) { await page.goto('/history'); await page.getByRole('button', { name: `Delete ${scenario.title}`, exact: true }).click(); return page.getByRole('dialog', { name: 'Delete this practice attempt?', exact: true }); }
async function seedDraft(page: Page) { await page.evaluate(({ id }) => { localStorage.setItem(`foundry-practice-draft:${id}`, JSON.stringify({ files: { 'main.py': '# Private draft\n' }, savedAt: new Date().toISOString() })); sessionStorage.setItem('unrelated-setting', 'keep'); }, { id }); }
const storageKey = (scope: string, account = owner) => `foundry-practice-pending:${encodeURIComponent(account)}:${encodeURIComponent(scope)}`;

test('account deletion keeps a delayed failure inside the busy dialog and reuses its body after close and reopen', async ({ page }, testInfo) => {
  await fixture(page); const bodies: string[] = []; const blocked = gate();
  await page.route('**/api/account', async route => { bodies.push(route.request().postData()!); if (bodies.length === 1) { await blocked.wait; return route.fulfill({ status: 503, json: { error: { message: 'Account deletion response unavailable. Confirm the retry.' } } }); } return route.fulfill({ json: { deleted: true } }); });
  let dialog = await openAccount(page); await seedDraft(page); await accountConfirm(dialog); await busyCannotClose(page, dialog, 'Deleting…'); await expect(dialog.getByLabel('Type DELETE to confirm')).toBeDisabled();
  blocked.release(); await expect(dialog.getByRole('alert')).toContainText('response unavailable'); await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue('DELETE');
  await page.setViewportSize({ width: 390, height: 844 }); await dialog.getByRole('alert').scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('account-error-mobile.png') });
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: 'Delete practice data', exact: true }).click(); dialog = page.getByRole('dialog'); await expect(dialog).toContainText('reuses its exact request'); expect(bodies).toHaveLength(1);
  await accountConfirm(dialog); await expect(dialog).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]);
  expect(await page.evaluate(({ id, key }) => ({ pending: sessionStorage.getItem(key), draft: localStorage.getItem(`foundry-practice-draft:${id}`), unrelated: sessionStorage.getItem('unrelated-setting') }), { id, key: storageKey('delete-account') })).toEqual({ pending: null, draft: null, unrelated: 'keep' });
});

test('account deletion lost acknowledgement survives reload with no automatic destructive replay', async ({ page }) => {
  await fixture(page); const bodies: string[] = [];
  await page.route('**/api/account', route => { bodies.push(route.request().postData()!); return bodies.length === 1 ? route.abort('failed') : route.fulfill({ json: { deleted: true } }); });
  let dialog = await openAccount(page); await accountConfirm(dialog); await expect(dialog.getByRole('alert')).toBeVisible(); await page.reload();
  await page.getByRole('button', { name: 'Delete practice data', exact: true }).click(); dialog = page.getByRole('dialog'); await expect(dialog).toContainText('Nothing was resent automatically'); await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue(''); expect(bodies).toHaveLength(1);
  await accountConfirm(dialog); await expect(dialog).toHaveCount(0); expect(bodies).toHaveLength(2); expect(bodies[1]).toBe(bodies[0]);
});

test('account 4xx and incomplete success preserve confirmation, original key and private drafts', async ({ page }) => {
  await fixture(page); const bodies: string[] = [];
  await page.route('**/api/account', route => { bodies.push(route.request().postData()!); return route.fulfill(bodies.length === 1 ? { status: 403, json: { error: { message: 'Deletion is temporarily forbidden.' } } } : { json: { scope: 'interview-practice-data' } }); });
  const dialog = await openAccount(page); await seedDraft(page); await accountConfirm(dialog); await expect(dialog.getByRole('alert')).toContainText('temporarily forbidden'); await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue('DELETE');
  await dialog.getByRole('button', { name: 'Delete Interview Lab data', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('response was interrupted'); expect(bodies[1]).toBe(bodies[0]);
  expect(await page.evaluate(id => localStorage.getItem(`foundry-practice-draft:${id}`), id)).not.toBeNull(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
});

test('deletion rechecks the signed-in owner and does not send after the account changes', async ({ page }) => {
  const { state } = await fixture(page); let deletes = 0;
  await page.route('**/api/account', route => { deletes++; return route.fulfill({ json: { deleted: true } }); });
  const dialog = await openAccount(page); state.owner = 'different-signed-in-owner'; await accountConfirm(dialog); await expect(dialog.getByRole('alert')).toContainText('account changed or signed out'); expect(deletes).toBe(0); await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue('DELETE');
});

test('attempt deletion blocks busy dismissal and keeps a 4xx error and malformed acknowledgement inside the dialog', async ({ page }) => {
  await fixture(page); const bodies: string[] = []; const blocked = gate();
  await page.route(`**/api/interview-practice/sessions/${id}`, async route => { if (route.request().method() !== 'DELETE') return route.fallback(); bodies.push(route.request().postData()!); if (bodies.length === 1) { await blocked.wait; return route.fulfill({ status: 403, json: { error: { message: 'Attempt deletion was not permitted.' } } }); } return route.fulfill(bodies.length === 2 ? { json: {} } : { json: { deleted: true } }); });
  let dialog = await openAttempt(page); await seedDraft(page); await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await busyCannotClose(page, dialog, 'Deleting…'); blocked.release(); await expect(dialog.getByRole('alert')).toContainText('not permitted');
  await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('response was interrupted'); expect(await page.evaluate(id => localStorage.getItem(`foundry-practice-draft:${id}`), id)).not.toBeNull();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: `Delete ${scenario.title}`, exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies).toHaveLength(3); expect(new Set(bodies).size).toBe(1); expect(await page.evaluate(id => localStorage.getItem(`foundry-practice-draft:${id}`), id)).toBeNull();
});

test('a deleted attempt with a lost acknowledgement remains explicitly recoverable after history reload', async ({ page }) => {
  const { state } = await fixture(page); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}`, route => { bodies.push(route.request().postData()!); state.sessions = []; return bodies.length === 1 ? route.abort('failed') : route.fulfill({ json: { deleted: true } }); });
  let dialog = await openAttempt(page); await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(dialog.getByRole('alert')).toBeVisible(); await page.reload();
  await expect(page.getByRole('button', { name: `Delete ${scenario.title}`, exact: true })).toHaveCount(0); await expect(page.getByRole('region', { name: 'Pending deletion confirmations' })).toContainText('Nothing is resent automatically'); expect(bodies).toHaveLength(1);
  await page.getByRole('button', { name: `Review deletion retry: ${scenario.title}`, exact: true }).click(); dialog = page.getByRole('dialog'); expect(bodies).toHaveLength(1); await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]); await expect(page.getByRole('region', { name: 'Pending deletion confirmations' })).toHaveCount(0);
});

for (const code of ['request_deleted', 'unrelated_gone'] as const) {
  test(`attempt deletion only clears the exact trusted 410 ${code} marker`, async ({ page }) => {
    await fixture(page); let deletes = 0;
    await page.route(`**/api/interview-practice/sessions/${id}`, route => { deletes++; return route.fulfill({ status: 410, json: { error: { code, message: 'Review saved attempts before starting a new action.' } } }); });
    const dialog = await openAttempt(page); await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Review saved attempts');
    await expect(dialog.getByRole('button', { name: 'Delete attempt', exact: true })).toBeEnabled({ enabled: code !== 'request_deleted' });
    const stored = await page.evaluate(key => sessionStorage.getItem(key), storageKey(`delete-session:${id}`)); expect(stored === null).toBe(code === 'request_deleted'); expect(deletes).toBe(1);
  });
}

for (const kind of ['account', 'attempt'] as const) {
  test(`expired ${kind} deletion requires discard without dispatch before a new explicit confirmation`, async ({ page }) => {
    await fixture(page); const bodies: string[] = []; const scope = kind === 'account' ? 'delete-account' : `delete-session:${id}`;
    await page.route(kind === 'account' ? '**/api/account' : `**/api/interview-practice/sessions/${id}`, route => { bodies.push(route.request().postData()!); return route.fulfill({ json: { deleted: true } }); });
    await page.goto(kind === 'account' ? '/settings' : '/history');
    await page.evaluate(({ key, account }) => { sessionStorage.setItem(key, JSON.stringify([['delete', { payload: JSON.stringify({ ...(account ? { confirmation: 'DELETE' } : {}), requestId: 'expired-original-deletion-key' }), uncertain: true, createdAt: '2000-01-01T00:00:00.000Z', title: 'Expired attempt' }]])); sessionStorage.setItem('unrelated-setting', 'keep'); }, { key: storageKey(scope), account: kind === 'account' });
    await page.reload(); await page.getByRole('button', { name: kind === 'account' ? 'Delete practice data' : `Delete ${scenario.title}`, exact: true }).click(); let dialog = page.getByRole('dialog'); await expect(dialog).toContainText('expired or its clock is invalid');
    if (kind === 'account') await dialog.getByLabel('Type DELETE to confirm').fill('DELETE'); await expect(dialog.getByRole('button', { name: kind === 'account' ? 'Delete Interview Lab data' : 'Delete attempt', exact: true })).toBeDisabled(); expect(bodies).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Discard expired deletion retry', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.getByRole('status').filter({ hasText: 'No request was sent' })).toBeVisible(); expect(bodies).toHaveLength(0);
    await page.getByRole('button', { name: kind === 'account' ? 'Delete practice data' : `Delete ${scenario.title}`, exact: true }).click(); dialog = page.getByRole('dialog'); expect(bodies).toHaveLength(0);
    if (kind === 'account') await accountConfirm(dialog); else await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies).toHaveLength(1); expect(JSON.parse(bodies[0]).requestId).not.toBe('expired-original-deletion-key'); expect(await page.evaluate(() => sessionStorage.getItem('unrelated-setting'))).toBe('keep');
  });
}

test('finish saves manual code first, blocks busy dismissal and retries a 503 with the original command', async ({ page }) => {
  const { session } = await fixture(page); const blocked = gate(); const bodies: string[] = []; const order: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => { order.push('save'); session.files = route.request().postDataJSON().files; session.revision++; return route.fulfill({ json: { session } }); });
  await page.route(`**/api/interview-practice/sessions/${id}/commands`, async route => { order.push('finish'); bodies.push(route.request().postData()!); if (bodies.length === 1) { await blocked.wait; return route.fulfill({ status: 503, json: { error: { message: 'Finish acknowledgement unavailable.' } } }); } session.codeFrozenSnapshotId = 'saved-final-snapshot'; session.stageId = 'debrief'; session.revision++; return route.fulfill({ json: { session } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true }).fill('# My manual implementation\n'); await page.getByRole('button', { name: 'Finish coding', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Finish coding?', exact: true }); await dialog.getByRole('button', { name: 'Finish coding and start debrief', exact: true }).click(); await busyCannotClose(page, dialog, 'Saving…'); blocked.release(); await expect(dialog.getByRole('alert')).toContainText('Finish acknowledgement unavailable');
  expect(order).toEqual(['save', 'finish']); expect(session.files['main.py']).toBe('# My manual implementation\n'); await dialog.getByRole('button', { name: 'Finish coding and start debrief', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]); await expect(page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true })).toHaveValue('# My manual implementation\n');
});

test('a finish save conflict stays in the dialog and preserves the unsent local draft', async ({ page }) => {
  await fixture(page); let commands = 0;
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => route.fulfill({ status: 409, json: { error: { message: 'Another tab changed the saved code. Your local draft was retained.' } } }));
  await page.route(`**/api/interview-practice/sessions/${id}/commands`, route => { commands++; return route.fulfill({ status: 500 }); });
  await page.goto(`/interview-practice/${id}`); const editor = page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true }); await editor.fill('# Unsaved manual work\n'); await page.getByRole('button', { name: 'Finish coding', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Finish coding?', exact: true }); await dialog.getByRole('button', { name: 'Finish coding and start debrief', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('local draft was retained'); expect(commands).toBe(0); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(editor).toHaveValue('# Unsaved manual work\n'); expect(await page.evaluate(id => JSON.parse(localStorage.getItem(`foundry-practice-draft:${id}`)!).files['main.py'], id)).toBe('# Unsaved manual work\n');
});

test('final submit lost acknowledgement keeps its dialog recoverable and does not create another submission', async ({ page }) => {
  const initial = attempt(); initial.codeFrozenSnapshotId = 'frozen-snapshot'; initial.stageId = 'debrief'; const { session } = await fixture(page, initial); const blocked = gate(); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/commands`, async route => { bodies.push(route.request().postData()!); if (bodies.length === 1) { session.lifecycle = 'reviewing'; session.revision++; await blocked.wait; return route.abort('failed'); } return route.fulfill({ json: { session } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('button', { name: 'Final submit', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Submit your completed attempt?', exact: true }); await dialog.getByRole('button', { name: 'Final submit', exact: true }).click(); await busyCannotClose(page, dialog, 'Saving…'); blocked.release(); await expect(dialog.getByRole('alert')).toBeVisible(); await dialog.getByRole('button', { name: 'Final submit', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0]).action).toBe('submit'); expect(session.revision).toBe(2); expect(session.files).toEqual(scenario.files);
});

for (const decision of ['accept', 'reject'] as const) {
  test(`pending edit ${decision} keeps failure visible, blocks busy dismissal and reuses its decision key`, async ({ page }) => {
    const initial = attempt(); initial.editProposals = [{ id: proposalId, jobId: 'assistant-job', baseSnapshotId: 'base-snapshot', baseSha256: 'a'.repeat(64), files: { 'main.py': '# Proposed edit\n' }, status: 'pending', createdAt: now }]; const { session } = await fixture(page, initial); const bodies: string[] = []; const blocked = gate();
    await page.route(`**/api/interview-practice/sessions/${id}/edit-decisions`, async route => { bodies.push(route.request().postData()!); if (bodies.length === 1) { await blocked.wait; return route.fulfill({ status: 503, json: { error: { message: 'Edit decision acknowledgement unavailable.' } } }); } session.editProposals[0].status = decision === 'accept' ? 'accepted' : 'rejected'; if (decision === 'accept') session.files = { ...session.files, ...session.editProposals[0].files }; session.revision++; return route.fulfill({ json: { session } }); });
    await page.goto(`/interview-practice/${id}`); await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click(); await page.getByRole('button', { name: 'Review changes', exact: true }).click(); let dialog = page.getByRole('dialog', { name: 'Review proposed edits', exact: true }); const label = decision === 'accept' ? 'Accept changes' : 'Reject changes'; await dialog.getByRole('button', { name: label, exact: true }).click(); await busyCannotClose(page, dialog, label); blocked.release(); await expect(dialog.getByRole('alert')).toContainText('Edit decision acknowledgement unavailable');
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await page.getByRole('button', { name: 'Review changes', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: label, exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]); expect(JSON.parse(bodies[0])).toMatchObject({ proposalId, decision }); expect(session.files['main.py']).toBe(decision === 'accept' ? '# Proposed edit\n' : scenario.files['main.py']);
  });
}

test('an edit accept save conflict does not send the decision or erase manual work', async ({ page }) => {
  const initial = attempt(); initial.editProposals = [{ id: proposalId, jobId: 'assistant-job', baseSnapshotId: 'base-snapshot', baseSha256: 'a'.repeat(64), files: { 'main.py': '# Proposed edit\n' }, status: 'pending', createdAt: now }]; await fixture(page, initial); let decisions = 0;
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => route.fulfill({ status: 409, json: { error: { message: 'Manual code could not be saved; the draft was retained.' } } }));
  await page.route(`**/api/interview-practice/sessions/${id}/edit-decisions`, route => { decisions++; return route.fulfill({ status: 500 }); });
  await page.goto(`/interview-practice/${id}`); const editor = page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true }); await editor.fill('# Keep my local code\n'); await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click(); await page.getByRole('button', { name: 'Review changes', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Accept changes', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('draft was retained'); expect(decisions).toBe(0); await page.keyboard.press('Escape'); await expect(editor).toHaveValue('# Keep my local code\n');
});

for (const kind of ['account', 'attempt'] as const) {
  for (const identityResult of ['changed', 'unknown'] as const) {
    test(`${kind} deletion acknowledged during ${identityResult} identity keeps browser data until explicit owner-scoped cleanup`, async ({ page }, testInfo) => {
      const { state } = await fixture(page); const bodies: string[] = []; const blocked = gate(); let identityUnknown = false;
      await page.route('**/api/auth/session', route => route.fulfill(identityUnknown ? { status: 503, json: { error: { message: 'Identity unavailable.' } } } : { json: { user: { id: state.owner, local: false }, authMode: 'supabase' } }));
      await page.route(kind === 'account' ? '**/api/account' : `**/api/interview-practice/sessions/${id}`, async route => {
        expect(route.request().headers()['x-practice-owner']).toBe(owner); bodies.push(route.request().postData()!); state.sessions = []; await blocked.wait; return route.fulfill({ json: { deleted: true } });
      });
      let dialog = kind === 'account' ? await openAccount(page) : await openAttempt(page); await seedDraft(page);
      await page.evaluate(key => { sessionStorage.setItem(key, 'other-owner-private-pending'); localStorage.setItem('foundry-practice-draft:other-owner-session-id', 'other-owner-private-draft'); }, storageKey('delete-account', 'another-owner'));
      if (kind === 'account') await accountConfirm(dialog); else await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click();
      await expect.poll(() => bodies.length).toBe(1); if (identityResult === 'changed') state.owner = 'another-owner'; else identityUnknown = true; blocked.release();
      await expect(dialog.getByRole('alert')).toContainText('Deletion was acknowledged for the original account. Browser cleanup is pending');
      await expect(dialog.getByRole('button', { name: kind === 'account' ? 'Delete Interview Lab data' : 'Delete attempt', exact: true })).toBeDisabled();
      const scope = kind === 'account' ? 'delete-account' : `delete-session:${id}`;
      const retained = await page.evaluate(({ key, other, id }) => ({ record: JSON.parse(sessionStorage.getItem(key)!), other: sessionStorage.getItem(other), draft: localStorage.getItem(`foundry-practice-draft:${id}`), otherDraft: localStorage.getItem('foundry-practice-draft:other-owner-session-id') }), { key: storageKey(scope), other: storageKey('delete-account', 'another-owner'), id });
      expect(retained.record[0][1].acknowledged).toBe(true); expect(retained.other).toBe('other-owner-private-pending'); expect(retained.draft).not.toBeNull(); expect(retained.otherDraft).toBe('other-owner-private-draft'); expect(bodies).toHaveLength(1);
      if (identityResult === 'changed') {
        state.owner = owner; await page.reload();
        if (kind === 'account') await page.getByRole('button', { name: 'Delete practice data', exact: true }).click(); else await page.getByRole('button', { name: `Review deletion retry: ${scenario.title}`, exact: true }).click();
        dialog = page.getByRole('dialog');
      }
      await expect(dialog).toContainText('No deletion will be resent'); expect(bodies).toHaveLength(1);
      if (kind === 'account' && identityResult === 'unknown') { await page.setViewportSize({ width: 390, height: 844 }); await dialog.getByRole('button', { name: 'Clear acknowledged browser data', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('acknowledged-cleanup-mobile.png') }); }
      await dialog.getByRole('button', { name: 'Clear acknowledged browser data', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies).toHaveLength(1);
      const cleaned = await page.evaluate(({ key, other, id }) => ({ own: sessionStorage.getItem(key), other: sessionStorage.getItem(other), draft: localStorage.getItem(`foundry-practice-draft:${id}`), otherDraft: localStorage.getItem('foundry-practice-draft:other-owner-session-id') }), { key: storageKey(scope), other: storageKey('delete-account', 'another-owner'), id });
      expect(cleaned).toEqual({ own: null, other: 'other-owner-private-pending', draft: null, otherDraft: 'other-owner-private-draft' });
    });
  }
  test(`${kind} deletion carries the intended owner through a before-send account race and retries the identical body`, async ({ page }) => {
    await fixture(page); const bodies: string[] = []; const headers: (string | undefined)[] = [];
    await page.route(kind === 'account' ? '**/api/account' : `**/api/interview-practice/sessions/${id}`, route => { bodies.push(route.request().postData()!); headers.push(route.request().headers()['x-practice-owner']); return route.fulfill(bodies.length === 1 ? { status: 409, json: { error: { code: 'owner_changed', message: 'Your account changed before deletion. Review the signed-in account.' } } } : { json: { deleted: true } }); });
    const dialog = kind === 'account' ? await openAccount(page) : await openAttempt(page); await seedDraft(page);
    if (kind === 'account') await accountConfirm(dialog); else await dialog.getByRole('button', { name: 'Delete attempt', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('account changed before deletion'); expect(await page.evaluate(id => localStorage.getItem(`foundry-practice-draft:${id}`), id)).not.toBeNull();
    await dialog.getByRole('button', { name: kind === 'account' ? 'Delete Interview Lab data' : 'Delete attempt', exact: true }).click(); await expect(dialog).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]); expect(headers).toEqual([owner, owner]);
  });
}
