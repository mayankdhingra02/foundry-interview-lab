import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

// Synthetic browser equipment/HTTP contracts. No real microphone, audio upload,
// speech provider, or code runner is used or qualified by these checks.
const id = 'acb83487-a9dc-4fb5-bf2c-afae5a847065'; const now = new Date().toISOString();
const scenario: PublicScenario = { id: 'voice-setup-fixture', version: '1.0.0', title: 'Voice setup fixture', summary: 'Explicit browser fixture.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Fixture' }, stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect the saved task.', requirements: ['Explain decisions.'] }], rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain evidence.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [], drills: [], rights: 'Original fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 } };
const capabilities = { ai: false, coaching: false, runner: false, voice: true, billing: false, accounts: true };
function attempt(): SessionView { return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, voice: true, accommodations: [] }, files: scenario.files, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' }; }
async function fixture(page: Page, session = attempt()) {
  const caps = { ...capabilities }; const creations: Record<string, unknown>[] = []; const speech: string[] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture API request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'voice-setup-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [scenario], capabilities: caps } }));
  await page.route('**/api/interview-practice/sessions', route => { creations.push(route.request().postDataJSON()); session.configuration.voice = creations.at(-1)!.voice === true; return route.fulfill({ status: 201, json: { session } }); });
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities: caps } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  await page.route('**/voice/**', route => { speech.push(route.request().url()); return route.fulfill({ status: 503, json: { error: { message: 'Speech fixture disabled.' } } }); });
  return { session, caps, creations, speech };
}
async function equipment(page: Page, mode: 'signal' | 'silent' | 'denied' | 'pending' | 'unsupported' = 'signal') {
  await page.addInitScript(({ mode }) => {
    const state = { requested: 0, stopped: 0, closed: 0, resolve: (() => {}) as () => void };
    Object.assign(window, { micFixture: state });
    const stream = { getTracks: () => [{ stop: () => { state.stopped++; } }] };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => { state.requested++; if (mode === 'denied') throw new DOMException('Fixture denied', 'NotAllowedError'); if (mode === 'pending') await new Promise<void>(resolve => { state.resolve = resolve; }); return stream; } });
    class LocalContext { resume() { return Promise.resolve(); } close() { state.closed++; return Promise.resolve(); } createMediaStreamSource() { return { connect() {}, disconnect() {} }; } createAnalyser() { return { fftSize: 256, getByteTimeDomainData(samples: Uint8Array) { samples.fill(mode === 'silent' ? 128 : 144); } }; } }
    class LocalRecorder { state = 'inactive'; onstop: (() => void) | null = null; start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.onstop?.(); } }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: LocalContext });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: mode === 'unsupported' ? undefined : LocalRecorder });
  }, { mode });
}
const equipmentState = (page: Page) => page.evaluate(() => { const { requested, stopped, closed } = (window as unknown as { micFixture: { requested: number; stopped: number; closed: number } }).micFixture; return { requested, stopped, closed }; });
async function voiceSetup(page: Page) { await page.goto('/interview-practice'); await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); const dialog = page.getByRole('dialog', { name: 'Set up your session', exact: true }); await dialog.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('voice'); return dialog; }
function debrief(session: SessionView) { session.codeFrozenSnapshotId = 'frozen-fixture'; session.stageId = 'debrief'; session.turns = [{ id: 'saved-question', role: 'interviewer', text: 'Explain the saved implementation.', source: 'authored', createdAt: now, evidenceIds: [] }]; }

test('voice equipment check starts only on click, releases input, and persists the selected preference', async ({ page }, testInfo) => {
  const data = await fixture(page); await equipment(page); const dialog = await voiceSetup(page);
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled(); expect((await equipmentState(page)).requested).toBe(0);
  await dialog.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit()); await expect(dialog.getByRole('alert')).toContainText('Complete the local microphone check'); expect(data.creations).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Check microphone locally', exact: true }).click(); await expect(dialog.getByRole('meter', { name: 'Microphone input level', exact: true })).toBeVisible(); await expect(dialog.getByText('Microphone input detected.', { exact: false })).toBeVisible(); expect(await equipmentState(page)).toEqual({ requested: 1, stopped: 1, closed: 1 });
  await page.setViewportSize({ width: 390, height: 844 }); await dialog.getByText('Microphone input detected.', { exact: false }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('local-microphone-check-mobile.png') });
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`); expect(data.creations).toHaveLength(1); expect(data.creations[0].voice).toBe(true); expect(data.speech).toEqual([]); await expect(page.getByText('Voice is available during the debrief.', { exact: false })).toBeVisible();
});

for (const mode of ['denied', 'silent', 'unsupported'] as const) {
  test(`a ${mode} equipment check offers text without speech requests`, async ({ page }) => {
    const data = await fixture(page); await equipment(page, mode); const dialog = await voiceSetup(page); await dialog.getByRole('button', { name: 'Check microphone locally', exact: true }).click(); await expect(dialog.getByRole('region', { name: 'Local microphone check' }).getByRole('alert')).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Continue in text', exact: true }).click(); await expect(dialog.getByRole('combobox', { name: 'Conversation', exact: true })).toHaveValue('text'); await dialog.getByRole('button', { name: 'Start session', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`); expect(data.creations[0].voice).toBe(false); expect(data.speech).toEqual([]);
  });
}

test('late microphone permission is released after choosing text', async ({ page }) => {
  const data = await fixture(page); await equipment(page, 'pending'); const dialog = await voiceSetup(page); await dialog.getByRole('button', { name: 'Check microphone locally', exact: true }).click(); await expect.poll(async () => (await equipmentState(page)).requested).toBe(1);
  await dialog.getByRole('button', { name: 'Continue in text', exact: true }).click(); await page.evaluate(() => (window as unknown as { micFixture: { resolve: () => void } }).micFixture.resolve()); await expect.poll(async () => (await equipmentState(page)).stopped).toBe(1); expect((await equipmentState(page)).closed).toBe(1); expect(data.creations).toEqual([]); expect(data.speech).toEqual([]);
});

test('stopping a check and closing setup both release the local microphone', async ({ page }) => {
  await fixture(page); await equipment(page); const dialog = await voiceSetup(page); await dialog.getByRole('button', { name: 'Check microphone locally', exact: true }).click(); await expect(dialog.getByRole('meter')).toBeVisible(); await dialog.getByRole('button', { name: 'Stop microphone check', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled(); expect(await equipmentState(page)).toEqual({ requested: 1, stopped: 1, closed: 1 });
  await dialog.getByRole('button', { name: 'Check microphone locally', exact: true }).click(); await expect(dialog.getByRole('meter')).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(await equipmentState(page)).toEqual({ requested: 2, stopped: 2, closed: 2 });
});

test('recovering an interrupted voice start reuses its body without a new equipment check', async ({ page }) => {
  const data = await fixture(page); await equipment(page); await page.goto('/interview-practice'); const body = { scenarioId: scenario.id, mode: 'practice', role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, voice: true, requestId: 'original-voice-admission-key' };
  await page.evaluate(({ body, now }) => sessionStorage.setItem('foundry-practice-pending:voice-setup-owner:creation', JSON.stringify([['create', { payload: JSON.stringify(body), createdAt: now, uncertain: true }]])), { body, now });
  await page.getByRole('button', { name: 'Set up practice', exact: true }).click(); await page.getByRole('button', { name: 'Retry start', exact: true }).click(); await expect(page).toHaveURL(`/interview-practice/${id}`); expect(data.creations).toEqual([body]); expect((await equipmentState(page)).requested).toBe(0); expect(data.speech).toEqual([]);
});

test('workspace distinguishes saved text preference, stage limits, configuration, and processing consent', async ({ page }) => {
  const data = await fixture(page); await equipment(page); await page.goto(`/interview-practice/${id}`); await expect(page.getByText('Voice is available during the debrief.', { exact: false })).toBeVisible(); await expect(page.getByText('Voice not configured', { exact: false })).toHaveCount(0);
  debrief(data.session); data.session.configuration.voice = false; await page.reload(); await expect(page.getByText('Text selected for this attempt · Voice is off', { exact: true })).toBeVisible();
  data.session.configuration.voice = true; data.caps.voice = false; await page.reload(); await expect(page.getByText('Voice not configured · Continue in text', { exact: true })).toBeVisible();
  data.caps.voice = true; await page.reload(); await expect(page.getByRole('button', { name: 'Record answer', exact: true })).toBeDisabled(); await expect(page.getByLabel('Your explanation', { exact: true })).toBeEnabled(); expect((await equipmentState(page)).requested).toBe(0); expect(data.speech).toEqual([]);
});

test('losing voice capability releases active capture and preserves text participation', async ({ page }) => {
  const session = attempt(); debrief(session); const data = await fixture(page, session); await equipment(page); await page.goto(`/interview-practice/${id}`);
  await page.getByRole('checkbox', { name: 'Allow sending recordings and selected interviewer questions to Deepgram for speech processing.', exact: true }).check(); await page.getByRole('button', { name: 'Record answer', exact: true }).click(); await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible(); data.caps.voice = false;
  await expect(page.getByText('Voice not configured · Continue in text', { exact: true })).toBeVisible(); expect((await equipmentState(page)).stopped).toBe(1); await expect(page.getByLabel('Your explanation', { exact: true })).toBeEnabled(); expect(data.speech).toEqual([]);
});
