import { completeFixtureJob } from './inference-fixtures';
import { describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { buildEvidence } from '../lib/interview-practice/evidence';
import { SessionService } from '../lib/server/session-service';
import { InteractionService } from '../lib/server/interactions';
import { MemoryPracticeStore } from '../lib/server/store';

let number = 0;
const key = () => `interaction-test-${++number}`;
async function setup(mode: 'practice' | 'simulation' = 'practice', aiHelp = true) {
  const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario);
  const session = (await service.createSession('owner', { scenarioId: 'monetary-validation', requestId: key(), mode, aiHelp })).session;
  return { store, service, session, interactions: new InteractionService(store) };
}
describe('learner interview controls', () => {
  it('clarifies only published requirements and leaves code, jobs, turns, usage and evidence intact', async () => {
    const { service, session, interactions } = await setup();
    const before = await service.exportSession('owner', session.id), evidence = buildEvidence(before);
    const result = await interactions.interact('owner', session.id, { action: 'clarify', expectedRevision: session.revision, requestId: key() });
    expect(result.response).toContain(session.scenario.summary);
    expect(result.session.turns).toEqual([]); expect(result.session.jobs).toEqual([]);
    expect(result.session.files).toEqual(before.files); expect(result.session.usage).toEqual(before.usage);
    expect(buildEvidence(await service.exportSession('owner', session.id))).toEqual(evidence);
    expect(result.session.events.at(-1)).toMatchObject({ type: 'interview.interaction', source: 'learner', payload: { action: 'clarify', topic: 'requirements' } });
    expect(result.response).not.toContain(getScenario(session.scenarioId)!.referenceFiles['quote.py']);
  });
  it('records working without creating an answer, advancing a checkpoint or pausing', async () => {
    const { session, interactions } = await setup();
    const result = await interactions.interact('owner', session.id, { action: 'working', expectedRevision: session.revision, requestId: key() });
    expect(result.session.lifecycle).toBe('active'); expect(result.session.stageId).toBe(session.stageId);
    expect(result.session.turns).toEqual([]); expect(result.session.revision).toBe(session.revision + 1);
  });
  it('repeats exactly the committed question without consuming question coverage', async () => {
    const { session, service, interactions } = await setup();
    await expect(interactions.interact('owner', session.id, { action: 'repeat', expectedRevision: session.revision, requestId: key() })).rejects.toMatchObject({ code: 'conflict' });
    await service.command('owner', session.id, { action: 'finish', expectedRevision: session.revision, requestId: key() });
    const claim = (await service.claimJob('worker'))!;
    const scenario = getScenario(session.scenarioId)!, probe = scenario.probes.find(item => item.stageId === 'debrief')!;
    await completeFixtureJob(service, claim, { kind: 'interviewer', model: 'authored', proposal: { action: 'ask_probe', question: probe.question, competencyId: probe.competencyId, probeId: probe.id, evidenceIds: [] }, actualUsd: 0 });
    const current = await service.getSession('owner', session.id);
    const result = await interactions.interact('owner', session.id, { action: 'repeat', expectedRevision: current.revision, requestId: key() });
    expect(result.response).toBe(current.turns.at(-1)!.text); expect(result.questionId).toBe(current.turns.at(-1)!.id);
    expect(result.session.turns).toEqual(current.turns); expect(result.session.jobs).toEqual(current.jobs);
  });
  it('replays a lost acknowledgement exactly and rejects changed input or another owner', async () => {
    const { session, interactions } = await setup();
    const input = { action: 'working' as const, expectedRevision: session.revision, requestId: key() };
    const first = await interactions.interact('owner', session.id, input);
    expect(await interactions.interact('owner', session.id, input)).toEqual(first);
    await expect(interactions.interact('owner', session.id, { ...input, action: 'clarify' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(interactions.interact('other', session.id, input)).rejects.toMatchObject({ code: 'not_found' });
    await expect(interactions.interact('owner', session.id, { ...input, requestId: key() })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('keeps assistance policy and advisory timing explicit without exposing hints in simulation', async () => {
    const { session, interactions } = await setup('simulation', false);
    const result = await interactions.interact('owner', session.id, { action: 'clarify', topic: 'assistance', expectedRevision: session.revision, requestId: key() });
    expect(result.response).toContain('Coding assistance is off'); expect(result.response).toContain('hints are unavailable');
    const timing = await interactions.interact('owner', session.id, { action: 'clarify', topic: 'timing', expectedRevision: result.session.revision, requestId: key() });
    expect(timing.response).toContain('does not automatically submit or grade');
    await expect(interactions.interact('owner', session.id, { action: 'working', topic: 'requirements', expectedRevision: timing.session.revision, requestId: key() })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('refuses controls while paused or after final submission', async () => {
    const { session, service, interactions } = await setup();
    await service.command('owner', session.id, { action: 'pause', expectedRevision: session.revision, requestId: key() });
    let current = await service.getSession('owner', session.id);
    await expect(interactions.interact('owner', session.id, { action: 'working', expectedRevision: current.revision, requestId: key() })).rejects.toMatchObject({ code: 'conflict' });
    await service.command('owner', session.id, { action: 'resume', expectedRevision: current.revision, requestId: key() });
    current = await service.getSession('owner', session.id);
    await service.command('owner', session.id, { action: 'finish', expectedRevision: current.revision, requestId: key() });
    current = await service.getSession('owner', session.id);
    await service.cancelJob('owner', current.jobs[0].id, { requestId: key() });
    current = await service.getSession('owner', session.id);
    await service.command('owner', session.id, { action: 'submit', expectedRevision: current.revision, requestId: key() });
    current = await service.getSession('owner', session.id);
    await expect(interactions.interact('owner', session.id, { action: 'working', expectedRevision: current.revision, requestId: key() })).rejects.toMatchObject({ code: 'conflict' });
  });
});
