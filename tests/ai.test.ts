import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { coach, interview, assist, observationOnlyReport, ProviderFailure } from '../lib/ai/provider';
import { inferenceReservations, modelPolicy } from '../lib/ai/policy';
import { freezeEvidence } from '../lib/interview-practice/evidence';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import type { Session } from '../lib/interview-practice/types';

const scenario = getScenario('monetary-validation')!;
let session: Session, service: SessionService;
const fetchMock = vi.fn();
function respond(value: unknown, overrides = {}) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'resp_fixture', status: 'completed', model: 'fixture-returned-model', usage: { input_tokens: 1200, output_tokens: 250 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }], ...overrides }), { headers: { 'x-request-id': 'request_fixture' } }));
}
beforeEach(async () => {
  vi.stubEnv('OPENAI_API_KEY', 'test-key-never-sent'); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true');
  vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400');
  service = new SessionService(new MemoryPracticeStore(), getScenario);
  const result = await service.createSession('fixture-owner', { scenarioId: scenario.id, requestId: 'fixture-admission' });
  session = await service.exportSession('fixture-owner', result.session.id); session.stageId = 'debrief';
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('provider role and evidence boundary', () => {
  it('sends strict structured responses with no tools or reference/protected material to the assistant', async () => {
    respond({ message: 'Inspect how invalid input reaches the calculation.', files: [] });
    const result = await assist(scenario, session, { mode: 'ask', prompt: 'Help me trace this.' });
    const [url, options] = fetchMock.mock.calls[0]; const body = JSON.parse(options.body);
    expect(url).toBe('https://api.openai.com/v1/responses'); expect(body.store).toBe(false); expect(body.tools).toBeUndefined();
    expect(body.text.format.strict).toBe(true); expect(body.instructions).toContain('untrusted quoted data');
    const input = body.input[0].content;
    expect(input).not.toContain(scenario.tests.find(t => !t.visible)!.source);
    expect(input).not.toContain(Object.values(scenario.referenceFiles).join(''));
    expect(result.inference).toMatchObject({ requestedModel: 'gpt-5.4-mini', returnedModel: 'fixture-returned-model', inputTokens: 1200, outputTokens: 250, validated: true });
  });
  it('refuses assistant edits outside the admitted path set and retains known billed usage', async () => {
    respond({ message: 'Proposed', files: [{ path: '../secret.py', content: 'x' }] });
    try { await assist(scenario, session, { mode: 'edit', prompt: 'Fix it' }); throw new Error('expected rejection'); }
    catch (error) { expect(error).toBeInstanceOf(ProviderFailure); expect((error as ProviderFailure).inference!.usd).toBeGreaterThan(0); }
  });
  it('falls back to authored coverage when a model cites invented evidence', async () => {
    respond({ action: 'ask_probe', question: 'Why did this pass?', competencyId: scenario.rubric[0].id, probeId: scenario.probes[0].id, evidenceIds: ['invented'] });
    const result = await interview(scenario, session);
    expect(result).toMatchObject({ kind: 'interviewer', model: 'authored', inference: { validated: false } });
    expect(result.actualUsd).toBeGreaterThan(0);
  });
  it('does not let the model end before required coverage', async () => {
    respond({ action: 'end_debrief', question: null, competencyId: null, probeId: null, evidenceIds: [] });
    const result = await interview(scenario, session);
    expect(result.kind === 'interviewer' && result.proposal.action).toBe('ask_probe');
  });
  it('produces an explicitly unassessed report when inference is absent', async () => {
    vi.stubEnv('OPENAI_API_KEY', ''); session.frozenEvidence = freezeEvidence(session, new Date().toISOString());
    const result = await coach(scenario, session);
    expect(result.kind === 'coach' && result.report.rubric.every(r => r.level === 'Not observed')).toBe(true);
    expect(result.actualUsd).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects unknown report citations and keeps the original frozen evidence', async () => {
    session.frozenEvidence = freezeEvidence(session, new Date().toISOString());
    const digest = session.frozenEvidence.digest, output = observationOnlyReport(scenario);
    output.rubric[0] = { ...output.rubric[0], level: 'Strong', evidenceIds: ['invented'] }; respond(output);
    const result = await coach(scenario, session);
    expect(result.kind === 'coach' && result.report.rubric[0].level).toBe('Not observed');
    expect(result.inference?.validated).toBe(false); expect(session.frozenEvidence.digest).toBe(digest);
  });
  it('preserves uncertain spend for an interrupted or malformed provider response', async () => {
    fetchMock.mockRejectedValue(new Error('network disconnected'));
    expect((await interview(scenario, session)).actualUsd).toBeUndefined();
    fetchMock.mockResolvedValue(new Response('invalid JSON'));
    expect((await interview(scenario, session)).actualUsd).toBeUndefined();
  });
  it('records refusals with usage without turning them into fabricated feedback', async () => {
    respond({}, { output: [{ content: [{ type: 'refusal', refusal: 'Cannot comply' }] }] });
    const result = await interview(scenario, session);
    expect(result).toMatchObject({ model: 'authored', inference: { validated: false } }); expect(result.actualUsd).toBeGreaterThan(0);
  });
  it('budgets inference using the configured model prices and rejects unpriced model overrides', () => {
    const normal = inferenceReservations(); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '3');
    expect(inferenceReservations().coach).toBeGreaterThan(normal.coach);
    vi.stubEnv('OPENAI_MODEL', 'different-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '');
    expect(modelPolicy).toThrow();
  });
  it('keeps provider request identifiers out of learner job views', async () => {
    const view = await service.getSession('fixture-owner', session.id);
    await service.requestAssistant('fixture-owner', session.id, { requestId: 'fixture-assistant', expectedRevision: view.revision, mode: 'ask', message: 'Explain' });
    const claim = await service.claimJob('fixture-worker'); respond({ message: 'Trace the call.', files: [] });
    const result = await assist(scenario, session, { mode: 'ask', prompt: 'Explain' });
    await service.completeJob(claim!, result);
    expect(JSON.stringify(await service.getSession('fixture-owner', session.id))).not.toContain('request_fixture');
    expect((await service.exportSession('fixture-owner', session.id)).jobs[0].inference?.providerRequestId).toBe('request_fixture');
  });
});
