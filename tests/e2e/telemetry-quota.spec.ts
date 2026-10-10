import { expect, test, type Page } from '@playwright/test';
import { browserObservation, type BrowserObservation } from '../../lib/interview-practice/telemetry';
import type { CoachingReport, JobView, PublicScenario, SessionView } from '../../lib/interview-practice/types';

// All HTTP, microphone/conversion and audio output below are explicit fixtures.
// No real runner, microphone, inference, speech, payment or paid admission occurs.
const id = '5163e57f-c3e4-41aa-a4dc-c4f1a73b418e';
const jobId = '32322af3-b42c-43e4-81da-6ceaf7616d56';
const reportId = 'aeab549c-47d8-4dc8-b8b3-f295e792cbbe';
const questionId = 'f5599293-6d8b-4bb3-852a-2b75ab3bf8af';
const nextQuestionId = '1a151454-c2e7-4d3a-b6d0-dce2e96e9d9f';
const now = new Date().toISOString();
const code = '# private implementation never enters observation payloads\n';
const answer = 'Private explanation never enters observation payloads.';
const scenario: PublicScenario = {
  id: 'measurement-quota-fixture', version: '1.0.0', title: 'Measurement and quota fixture', summary: 'Synthetic learner state.', durationMinutes: 45, level: 'Mid-level', tags: ['reasoning'], language: 'python', files: { 'main.py': '# Saved original\n' },
  stages: [{ id: 'inspect', title: 'Inspect', brief: 'Inspect the implementation.', requirements: ['Keep evidence separate.'] }, { id: 'debrief', title: 'Discuss', brief: 'Explain your implementation.', requirements: [] }],
  rubric: [{ id: 'reasoning', name: 'Reasoning', description: 'Explain choices.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }], tests: [{ id: 'public', title: 'Authored fixture check', visible: true, source: '# Synthetic source', timeoutSeconds: 3 }], drills: [], rights: 'Original fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 },
};
function attempt(debrief = false): SessionView {
  return { id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario: structuredClone(scenario), mode: 'practice', lifecycle: 'active', stageId: debrief ? 'debrief' : 'inspect', revision: 1, configuration: { role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 45, aiHelp: true, voice: true, accommodations: [] }, files: { ...scenario.files }, codeFrozenSnapshotId: debrief ? 'frozen-snapshot' : null, frozenEvidence: null, events: [], turns: debrief ? [{ id: questionId, role: 'interviewer', text: 'Explain this saved implementation.', source: 'authored', createdAt: now, evidenceIds: [] }] : [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh' };
}
function job(kind: JobView['kind'], requestId: string): JobView { return { id: jobId, sessionId: id, kind, state: 'queued', requestId, snapshotId: 'frozen-snapshot', createdAt: now, updatedAt: now, attempt: 0, reservationSequence: 1, fencingToken: 0, leaseExpiresAt: null, cancellationRequested: false, reservedUsd: 0 }; }
function report(): CoachingReport { return { id: reportId, generationId: 'bc9df5f3-45ee-4af7-bd87-3df7cce80ea7', createdAt: now, model: 'authored-observation-only', promptVersion: 'fixture-v1', rubricVersion: '1.0.0', evidenceDigest: 'a'.repeat(64), evidence: [], overview: 'Fixture review only.', rubric: [{ criterionId: 'reasoning', level: 'Not observed', feedback: 'No validated assessment.', confidence: 'low', evidenceIds: [] }], nextPractice: [] }; }
async function fixture(page: Page, session = attempt(), telemetry = true) {
  const observations: BrowserObservation[] = []; const saves: string[] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'measurement-fixture-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  const capabilities = { ai: true, coaching: false, runner: true, voice: true, billing: false, accounts: true, telemetry };
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: { session, scenario: session.scenario, capabilities } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, route => { saves.push(route.request().postData()!); session.files = route.request().postDataJSON().files; session.revision++; return route.fulfill({ json: { session } }); });
  await page.route(`**/api/interview-practice/sessions/${id}/observations`, route => { observations.push(route.request().postDataJSON()); return route.fulfill({ json: { accepted: true } }); });
  return { session, observations, saves };
}
const metric = (observations: BrowserObservation[], name: string) => observations.filter(item => item.event === 'latency.measured' && item.metric === name);
const editor = (page: Page) => page.getByLabel('Edit main.py. Tab moves to the next control.', { exact: true });
function safe(observations: BrowserObservation[]) {
  for (const observation of observations) {
    expect(browserObservation.safeParse(observation).success).toBe(true);
    expect(JSON.stringify(observation)).not.toMatch(/private|implementation|explanation|transcript|recording|error|userId|ownerId|origin|source|audioBytes/);
  }
}

test('telemetry off makes no observation requests for saves, run results or opened feedback', async ({ page }) => {
  const data = await fixture(page, attempt(), false);
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { const requestId = route.request().postDataJSON().requestId; data.session.jobs.push({ ...job('run', requestId), state: 'completed' }); data.session.runs.push({ id: 'fixture-run', jobId, snapshotId: 'fixture-snapshot', snapshotSha256: 'b'.repeat(64), createdAt: now, testSuiteDigest: 'c'.repeat(64), status: 'completed', command: 'Synthetic only', stdout: '', stderr: '', exitCode: 0, durationMs: 1, tests: [{ id: 'public', title: 'Authored fixture check', status: 'passed' }] }); data.session.revision++; return route.fulfill({ json: { session: data.session, job: { id: jobId } } }); });
  await page.goto(`/interview-practice/${id}`); await editor(page).fill(code); await page.getByRole('button', { name: 'Run tests', exact: true }).click(); await expect(page.getByRole('region', { name: 'Authored scenario check result', exact: true })).toBeVisible();
  data.session.lifecycle = 'completed'; data.session.reports.push(report()); await page.reload(); await expect(page.getByRole('heading', { name: 'Your practice review', exact: true })).toBeVisible();
  expect(data.observations).toEqual([]);
});

test('save timing waits for its actual acknowledgement and contains only the observation schema', async ({ page }) => {
  const data = await fixture(page); let release = () => {}; const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/api/interview-practice/sessions/${id}/workspace`, async route => { await wait; return route.fallback(); });
  await page.goto(`/interview-practice/${id}`); await editor(page).fill(code); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect(page.getByText('Saving…', { exact: true })).toBeVisible(); expect(data.observations).toEqual([]); release();
  await expect.poll(() => metric(data.observations, 'workspace.save').length).toBe(1); expect(metric(data.observations, 'workspace.save')[0]).toMatchObject({ outcome: 'acknowledged' }); safe(data.observations); expect(data.session.files['main.py']).toBe(code);
});

test('admitted run timing ends at a correlated rendered result rather than admission', async ({ page }) => {
  const data = await fixture(page);
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { data.session.jobs.push(job('run', route.request().postDataJSON().requestId)); data.session.revision++; return route.fulfill({ json: { session: data.session, job: { id: jobId } } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('button', { name: 'Run tests', exact: true }).click(); await expect(page.getByRole('button', { name: 'Running…', exact: true })).toBeVisible(); expect(metric(data.observations, 'run.result')).toEqual([]);
  data.session.jobs[0].state = 'completed'; data.session.runs.push({ id: 'fixture-run', jobId, snapshotId: 'fixture-snapshot', snapshotSha256: 'b'.repeat(64), createdAt: now, testSuiteDigest: 'c'.repeat(64), status: 'completed', command: 'Synthetic only', stdout: '', stderr: '', exitCode: 0, durationMs: 1, tests: [{ id: 'public', title: 'Authored fixture check', status: 'passed' }] }); data.session.revision++;
  await expect(page.getByRole('region', { name: 'Authored scenario check result', exact: true })).toBeVisible(); await expect.poll(() => metric(data.observations, 'run.result').length).toBe(1); expect(metric(data.observations, 'run.result')[0]).toMatchObject({ jobId, outcome: 'acknowledged' }); safe(data.observations);
});

test('answer timing includes queue and polling until the correlated interviewer question appears', async ({ page }) => {
  const data = await fixture(page, attempt(true)); let wireRequestId = '';
  await page.route(`**/api/interview-practice/sessions/${id}/turns`, route => { wireRequestId = route.request().postDataJSON().requestId; data.session.jobs.push(job('interviewer', wireRequestId)); data.session.turns.push({ id: 'learner-turn', role: 'learner', text: answer, source: 'typed', replyTo: questionId, createdAt: now, evidenceIds: [] }); data.session.revision++; return route.fulfill({ json: { session: data.session, job: { id: jobId } } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByLabel('Your explanation', { exact: true }).fill(answer); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.getByText(answer, { exact: true })).toBeVisible(); expect(metric(data.observations, 'text.turn')).toEqual([]);
  await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click();
  data.session.jobs[0].state = 'completed'; data.session.turns.push({ id: nextQuestionId, role: 'interviewer', text: 'What recorded evidence supports that explanation?', source: 'authored', createdAt: now, evidenceIds: [] }); data.session.events.push({ id: 'question-event', sessionId: id, sequence: 1, schemaVersion: 1, occurredAt: now, recordedAt: now, source: 'server', requestId: wireRequestId, type: 'interviewer.question', payload: { turnId: nextQuestionId, competencyId: 'reasoning', model: 'authored' } }); data.session.revision++;
  await page.waitForResponse(response => response.url().endsWith(`/sessions/${id}`)); await expect(page.locator(`#turn-${nextQuestionId}`)).toHaveCount(0); expect(metric(data.observations, 'text.turn')).toEqual([]); await page.getByRole('tab', { name: 'Interviewer', exact: true }).click();
  await expect(page.getByText('What recorded evidence supports that explanation?', { exact: true })).toBeVisible(); await expect.poll(() => metric(data.observations, 'text.turn').length).toBe(1); expect(metric(data.observations, 'text.turn')[0]).toMatchObject({ jobId, outcome: 'acknowledged' }); safe(data.observations);
});

test('report admission ends at the rendered correlated report and feedback opens once per version', async ({ page }) => {
  const data = await fixture(page, attempt(true));
  await page.route(`**/api/interview-practice/sessions/${id}/commands`, route => { data.session.jobs.push(job('coach', route.request().postDataJSON().requestId)); data.session.lifecycle = 'reviewing'; data.session.revision++; return route.fulfill({ json: { session: data.session, job: { id: jobId } } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('button', { name: 'Final submit', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Final submit', exact: true }).click(); await expect(page.getByText('Preparing your report from the frozen attempt…', { exact: true })).toBeVisible(); expect(metric(data.observations, 'report.ready')).toEqual([]);
  data.session.jobs[0].state = 'completed'; data.session.lifecycle = 'completed'; data.session.reports.push(report()); data.session.events.push({ id: 'coaching-event', sessionId: id, sequence: 1, schemaVersion: 1, occurredAt: now, recordedAt: now, source: 'server', requestId: data.session.jobs[0].requestId, type: 'coaching.ready', payload: { jobId, reportId } }); data.session.revision++;
  await expect(page.getByRole('heading', { name: 'Your practice review', exact: true })).toBeVisible(); await expect.poll(() => metric(data.observations, 'report.ready').length).toBe(1); await expect.poll(() => data.observations.filter(item => item.event === 'feedback.opened').length).toBe(1); expect(metric(data.observations, 'report.ready')[0]).toMatchObject({ jobId, outcome: 'acknowledged' }); safe(data.observations);
  const corrected = { ...report(), id: '5b6dd028-c44c-4d30-9f29-e790c8c99c20', model: 'staff-reviewed', correction: { sourceReportId: reportId, reason: 'Explicit fixture correction.', publishedAt: now } }; data.session.reports.push(corrected); data.session.revision++;
  await expect(page.getByText('Staff-reviewed correction', { exact: true })).toBeVisible(); await expect.poll(() => data.observations.filter(item => item.event === 'feedback.opened').length).toBe(2); await page.getByLabel('Report version').selectOption(reportId); await expect(page.getByText('You are viewing an earlier report.', { exact: false })).toBeVisible(); await page.getByLabel('Report version').selectOption(corrected.id); expect(data.observations.filter(item => item.event === 'feedback.opened')).toHaveLength(2);
});

test('observation HTTP and network failures never block saves, add an error or retry', async ({ page }) => {
  const data = await fixture(page); let observationCalls = 0;
  await page.route(`**/api/interview-practice/sessions/${id}/observations`, route => { observationCalls++; return observationCalls === 1 ? route.fulfill({ status: 503, json: { error: { message: 'Private telemetry sink failure' } } }) : route.abort('failed'); });
  await page.goto(`/interview-practice/${id}`); await editor(page).fill(code); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => observationCalls).toBe(1); await expect(page.getByText('Saved', { exact: true })).toBeVisible(); await editor(page).fill(code + '# Second save\n'); await page.getByRole('button', { name: 'Save', exact: true }).click(); await expect.poll(() => observationCalls).toBe(2); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0); await page.reload(); await expect(editor(page)).toHaveValue(code + '# Second save\n'); expect(observationCalls).toBe(2); expect(data.saves).toHaveLength(2);
});

test('run quota preserves the saved implementation and allows a fresh explicit action after definitive rejection', async ({ page }) => {
  const data = await fixture(page); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { bodies.push(route.request().postData()!); return route.fulfill({ status: 429, json: { error: { code: 'quota_exhausted', message: 'Run allowance exhausted. Your saved work remains available.' } } }); });
  await page.goto(`/interview-practice/${id}`); await editor(page).fill(code); await page.getByRole('button', { name: 'Run tests', exact: true }).click(); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('Run allowance exhausted'); await expect(editor(page)).toHaveValue(code); expect(data.session.files['main.py']).toBe(code); expect(data.session.jobs).toHaveLength(0); expect(metric(data.observations, 'run.result')).toEqual([]); await expect(page.getByRole('button', { name: 'Recover authored checks', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run tests', exact: true }).click(); await expect.poll(() => bodies.length).toBe(2); expect(JSON.parse(bodies[1]).requestId).not.toBe(JSON.parse(bodies[0]).requestId);
});

test('assistant quota keeps the unsent explanation and never creates synthetic assistance', async ({ page }) => {
  const data = await fixture(page); const bodies: string[] = [];
  await page.route(`**/api/interview-practice/sessions/${id}/assistant`, route => { bodies.push(route.request().postData()!); return route.fulfill({ status: 429, json: { error: { code: 'quota_exhausted', message: 'AI allowance exhausted. Continue with saved code and authored checks.' } } }); });
  await page.goto(`/interview-practice/${id}`); await editor(page).fill(code); await page.getByRole('tab', { name: 'Coding assistant', exact: true }).click(); const input = page.getByLabel('Ask the coding assistant', { exact: true }); await input.fill(answer); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('AI allowance exhausted'); await expect(input).toHaveValue(answer); expect(data.session.files['main.py']).toBe(code); expect(data.session.assistantMessages).toHaveLength(0); expect(data.session.jobs).toHaveLength(0); expect(bodies).toHaveLength(1);
});

test('quota during an uncertain run recovery retains the exact request across refresh and never auto replays', async ({ page }) => {
  const data = await fixture(page); const bodies: string[] = []; let admissions = 0;
  await page.route(`**/api/interview-practice/sessions/${id}/runs`, route => { bodies.push(route.request().postData()!); if (bodies.length === 1) { admissions++; data.session.revision++; return route.abort('failed'); } if (bodies.length === 2) return route.fulfill({ status: 429, json: { error: { message: 'Recovery temporarily limited; the original key is retained.' } } }); return route.fulfill({ json: { session: data.session } }); });
  await page.goto(`/interview-practice/${id}`); await editor(page).fill(code); await page.getByRole('button', { name: 'Run tests', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover authored checks', exact: true })).toBeVisible(); await page.reload(); await expect(page.getByRole('button', { name: 'Recover authored checks', exact: true })).toBeVisible(); expect(bodies).toHaveLength(1); await page.getByRole('button', { name: 'Recover authored checks', exact: true }).click(); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('Recovery temporarily limited'); await page.reload(); await expect(page.getByRole('button', { name: 'Recover authored checks', exact: true })).toBeVisible(); expect(bodies).toHaveLength(2); await page.getByRole('button', { name: 'Recover authored checks', exact: true }).click(); await expect(page.getByRole('button', { name: 'Recover authored checks', exact: true })).toHaveCount(0); expect(bodies[1]).toBe(bodies[0]); expect(bodies[2]).toBe(bodies[0]); expect(admissions).toBe(1); expect(data.session.files['main.py']).toBe(code);
});

test('report quota remains visible inside the confirmation and leaves the debrief intact', async ({ page }) => {
  const data = await fixture(page, attempt(true));
  await page.route(`**/api/interview-practice/sessions/${id}/commands`, route => route.fulfill({ status: 429, json: { error: { message: 'Report allowance exhausted. Your debrief is saved.' } } }));
  await page.goto(`/interview-practice/${id}`); await page.getByLabel('Your explanation', { exact: true }).fill(answer); await page.getByRole('button', { name: 'Final submit', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: 'Final submit', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Report allowance exhausted'); await page.keyboard.press('Escape'); await expect(page.getByLabel('Your explanation', { exact: true })).toHaveValue(answer); expect(data.session.lifecycle).toBe('active'); expect(data.session.reports).toHaveLength(0);
});

async function speechFixture(page: Page) {
  await page.addInitScript(() => {
    class Recorder { state = 'inactive'; mimeType = 'audio/webm'; onstop: (() => void) | null = null; ondataavailable: ((event: { data: Blob }) => void) | null = null; start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['fixture']) }); this.onstop?.(); } }
    class Decoder { decodeAudioData() { return Promise.resolve({ duration: 1 }); } close() { return Promise.resolve(); } }
    class Offline { destination = {}; createBufferSource() { return { buffer: null, connect() {}, start() {} }; } startRendering() { return Promise.resolve({ getChannelData: () => new Float32Array(16_000) }); } }
    class Output { onended: (() => void) | null = null; onerror: (() => void) | null = null; play() { return new Promise<void>(resolve => Object.assign(window, { startFixtureAudio: resolve })); } pause() {} }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => ({ getTracks: () => [{ stop() {} }] }) });
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: Recorder }); Object.defineProperty(window, 'AudioContext', { configurable: true, value: Decoder }); Object.defineProperty(window, 'OfflineAudioContext', { configurable: true, value: Offline }); Object.defineProperty(window, 'Audio', { configurable: true, value: Output });
  });
}

test('voice observations wait for the reviewed transcript and actual audio play promise', async ({ page }) => {
  const data = await fixture(page, attempt(true)); await speechFixture(page);
  await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: answer, source: 'transcribed' } })); await page.route('**/voice/speak', route => route.fulfill({ contentType: 'audio/mpeg', body: 'synthetic audio bytes, never played' }));
  await page.goto(`/interview-practice/${id}`); await page.getByRole('checkbox', { name: /Allow sending recordings/ }).check(); await page.getByRole('button', { name: 'Record answer', exact: true }).click(); await expect(page.getByRole('button', { name: 'Stop recording', exact: true })).toBeVisible(); expect(metric(data.observations, 'voice.transcribe')).toEqual([]); await page.getByRole('button', { name: 'Stop recording', exact: true }).click(); await expect(page.getByLabel('Review your transcript', { exact: true })).toHaveValue(answer); await expect.poll(() => metric(data.observations, 'voice.transcribe').length).toBe(1);
  await page.getByRole('button', { name: 'Play latest question', exact: true }).click(); await expect.poll(() => page.evaluate(() => typeof (window as unknown as { startFixtureAudio?: unknown }).startFixtureAudio)).toBe('function'); expect(metric(data.observations, 'voice.playback')).toEqual([]); await page.evaluate(() => (window as unknown as { startFixtureAudio: () => void }).startFixtureAudio()); await expect.poll(() => metric(data.observations, 'voice.playback').length).toBe(1); safe(data.observations); expect(metric(data.observations, 'voice.answer-to-audio')).toEqual([]);
});

test('repeating an identical transcript without clearing its review records two separate completion spans', async ({ page }) => {
  const data = await fixture(page, attempt(true)); await speechFixture(page); let transcriptions = 0;
  await page.route('**/voice/transcribe', route => { transcriptions++; return route.fulfill({ json: { text: answer, source: 'transcribed' } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByRole('checkbox', { name: /Allow sending recordings/ }).check();
  for (let count = 1; count <= 2; count++) {
    await page.getByRole('button', { name: 'Record answer', exact: true }).click(); await page.getByRole('button', { name: 'Stop recording', exact: true }).click(); await expect(page.getByLabel('Review your transcript', { exact: true })).toHaveValue(answer); await expect.poll(() => metric(data.observations, 'voice.transcribe').length).toBe(count);
  }
  expect(transcriptions).toBe(2); const completions = metric(data.observations, 'voice.transcribe'); expect(new Set(completions.map(item => item.eventId)).size).toBe(2); for (const completion of completions) expect(completion).toMatchObject({ outcome: 'acknowledged' }); safe(data.observations);
});

test('speech quota preserves the visible question and typed answer with safe text fallback', async ({ page }) => {
  const data = await fixture(page, attempt(true)); await speechFixture(page); let speechCalls = 0;
  await page.route('**/voice/**', route => { speechCalls++; return route.fulfill({ status: 429, json: { error: { message: 'Speech allowance exhausted. Continue in text.' } } }); });
  await page.goto(`/interview-practice/${id}`); await page.getByLabel('Your explanation', { exact: true }).fill(answer); await page.getByRole('checkbox', { name: /Allow sending recordings/ }).check(); await page.getByRole('button', { name: 'Play latest question', exact: true }).click(); await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toContainText('Speech allowance exhausted'); await expect(page.getByLabel('Your explanation', { exact: true })).toHaveValue(answer); await expect(page.getByText('Explain this saved implementation.', { exact: true })).toBeVisible(); expect(speechCalls).toBe(1); await expect.poll(() => metric(data.observations, 'voice.playback').length).toBe(1); expect(metric(data.observations, 'voice.playback')[0]).toMatchObject({ outcome: 'failed' }); safe(data.observations);
});

test('voice telemetry off sends no observations even when transcription completes', async ({ page }) => {
  const data = await fixture(page, attempt(true), false); await speechFixture(page); await page.route('**/voice/transcribe', route => route.fulfill({ json: { text: answer, source: 'transcribed' } }));
  await page.goto(`/interview-practice/${id}`); await page.getByRole('checkbox', { name: /Allow sending recordings/ }).check(); await page.getByRole('button', { name: 'Record answer', exact: true }).click(); await page.getByRole('button', { name: 'Stop recording', exact: true }).click(); await expect(page.getByLabel('Review your transcript', { exact: true })).toHaveValue(answer); expect(data.observations).toEqual([]);
});
