import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

// Synthetic browser permission and conversion races. No microphone hardware,
// speech provider, audio upload, runner, or paid service is used by these tests.
const id = '65e34a74-a720-44aa-887e-f05e8d7e2c3b';
const now = new Date().toISOString();
const scenario: PublicScenario = {
  id: 'voice-cancellation-fixture', version: '1.0.0', title: 'Voice cancellation fixture', summary: 'Saved synthetic work.', durationMinutes: 45,
  level: 'Intermediate', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Saved work' },
  stages: [{ id: 'debrief', title: 'Discuss', brief: 'Explain the saved work.', requirements: ['Use evidence.'] }],
  rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain decisions.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }],
  tests: [], drills: [], rights: 'Original synthetic fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 },
};
async function fixture(page: Page, conversionPending = false) {
  const session: SessionView = {
    id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'active', stageId: 'debrief', revision: 1,
    configuration: { role: 'Backend engineer', level: 'Intermediate', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, voice: true, accommodations: [] },
    files: scenario.files, codeFrozenSnapshotId: 'saved-snapshot', frozenEvidence: null, events: [],
    turns: [{ id: 'saved-question', role: 'interviewer', text: 'Explain your saved implementation.', source: 'authored', createdAt: now, evidenceIds: [] }],
    runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [],
    usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh',
  };
  const speech: string[] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'voice-cancellation-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario, capabilities: { ai: false, coaching: false, runner: false, voice: true, billing: false, accounts: true } } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  await page.route('**/voice/**', route => { speech.push(route.request().url()); return route.fulfill({ status: 503, json: { error: { message: 'Speech fixture disabled.' } } }); });
  await page.addInitScript(({ conversionPending }) => {
    const state = { requested: 0, stopped: [] as number[], recorderStarts: 0, recorderStops: 0, decoding: 0, decoderClosed: 0, grant: {} as Record<number, () => void>, finishDecode: () => {} };
    Object.assign(window, { captureFixture: state });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const request = ++state.requested;
      await new Promise<void>(resolve => { state.grant[request] = resolve; });
      return { getTracks: () => [{ stop: () => { state.stopped.push(request); } }] };
    } });
    class Recorder {
      state = 'inactive'; mimeType = 'audio/webm'; onstop: (() => void) | null = null;
      start() { this.state = 'recording'; state.recorderStarts++; }
      stop() { this.state = 'inactive'; state.recorderStops++; this.onstop?.(); }
    }
    class Decoder {
      async decodeAudioData() {
        state.decoding++;
        if (conversionPending) await new Promise<void>(resolve => { state.finishDecode = resolve; });
        return { duration: 1 };
      }
      close() { state.decoderClosed++; return Promise.resolve(); }
    }
    class Offline {
      destination = {};
      createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
      startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(16_000) }); }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder });
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: Decoder });
    Object.defineProperty(window, 'OfflineAudioContext', { configurable: true, value: Offline });
  }, { conversionPending });
  await page.goto(`/interview-practice/${id}`);
  await page.getByRole('checkbox', { name: 'Allow sending recordings and selected interviewer questions to Deepgram for speech processing.', exact: true }).check();
  return { speech };
}
type CaptureState = { requested: number; stopped: number[]; recorderStarts: number; recorderStops: number; decoding: number; decoderClosed: number; grant: Record<number, () => void>; finishDecode: () => void };
const state = (page: Page) => page.evaluate(() => { const { requested, stopped, recorderStarts, recorderStops, decoding, decoderClosed } = (window as unknown as { captureFixture: CaptureState }).captureFixture; return { requested, stopped, recorderStarts, recorderStops, decoding, decoderClosed }; });
const grant = (page: Page, request: number) => page.evaluate(request => (window as unknown as { captureFixture: CaptureState }).captureFixture.grant[request](), request);

test('Cancel invalidates a pending permission request and releases its late stream without recording', async ({ page }) => {
  const data = await fixture(page);
  await page.getByRole('button', { name: 'Record answer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Waiting for microphone…', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel microphone request', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record answer', exact: true })).toBeEnabled();
  await grant(page, 1);
  await expect.poll(async () => (await state(page)).stopped).toEqual([1]);
  expect((await state(page)).recorderStarts).toBe(0);
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Your explanation', { exact: true })).toBeEnabled();
  await expect(page.getByText('Explain your saved implementation.', { exact: true })).toBeVisible();
  expect(data.speech).toEqual([]);
});

test('late permission from a cancelled capture cannot replace or stop a newer explicit recording', async ({ page }) => {
  const data = await fixture(page);
  await page.getByRole('button', { name: 'Record answer', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel microphone request', exact: true }).click();
  await page.getByRole('button', { name: 'Record answer', exact: true }).click();
  await grant(page, 2);
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await grant(page, 1);
  await expect.poll(async () => (await state(page)).stopped).toEqual([1]);
  expect((await state(page)).recorderStarts).toBe(1);
  await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click();
  await expect.poll(async () => (await state(page)).stopped).toEqual([1, 2]);
  expect((await state(page)).recorderStops).toBe(1);
  expect(data.speech).toEqual([]);
});

test('Cancel during audio conversion prevents a later upload and restores text controls', async ({ page }) => {
  const data = await fixture(page, true);
  await page.getByRole('button', { name: 'Record answer', exact: true }).click(); await grant(page, 1);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await expect.poll(async () => (await state(page)).decoding).toBe(1);
  await page.getByRole('button', { name: 'Cancel transcription', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Record answer', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { captureFixture: CaptureState }).captureFixture.finishDecode());
  await expect.poll(async () => (await state(page)).decoderClosed).toBe(1);
  await expect(page.getByLabel('Review your transcript', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Your explanation', { exact: true })).toBeEnabled();
  expect(data.speech).toEqual([]);
});
