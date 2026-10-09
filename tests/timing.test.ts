import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getScenario, listScenarios } from '../lib/content/scenarios';
import { toPublicScenario } from '../lib/interview-practice/domain';
import { freezeEvidence } from '../lib/interview-practice/evidence';
import { parsePracticeEvent } from '../lib/interview-practice/events';
import { buildProgression } from '../lib/interview-practice/progression';
import { describeTiming, practiceConditionsSchema, timingConditions } from '../lib/interview-practice/timing';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';

function fixture(options = {}) {
  const store = new MemoryPracticeStore();
  return { store, service: new SessionService(store, getScenario, options) };
}
const start = (service: SessionService, extra = {}) => service.createSession('timing-owner', { scenarioId: 'monetary-validation', requestId: randomUUID(), ...extra });
const extend = (service: SessionService, id: string, expectedRevision: number, additionalMinutes: 15 | 30 = 15, requestId = randomUUID()) => service.extendTiming('timing-owner', id, { requestId, expectedRevision, additionalMinutes });

describe('typed practice conditions and advisory timing', () => {
  it('accepts only offered options and collects no medical or disability narrative', async () => {
    expect(practiceConditionsSchema.safeParse({ timing: 'extra-15', participation: 'written-only' }).success).toBe(true);
    for (const value of [{ timing: 'unlimited', participation: 'written-only' }, { timing: 'standard', participation: 'written-only', diagnosis: 'private' }, { timing: 'standard' }]) {
      expect(practiceConditionsSchema.safeParse(value).success).toBe(false);
    }
    const policy = vi.fn(), { service, store } = fixture({ admissionPolicy: policy });
    await expect(start(service, { targetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' }, voice: true })).rejects.toMatchObject({ code: 'invalid' });
    expect(policy).not.toHaveBeenCalled(); expect((await store.read()).ledger).toEqual([]);
    const result = await start(service, { targetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' }, configuration: { originalTargetMinutes: 1 } });
    expect(result.session.configuration).toMatchObject({ voice: false, originalTargetMinutes: 60, targetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' } });
    expect(timingConditions(result.session.configuration)).toMatchObject({ setupExtraMinutes: 15, recordedConditionCount: 2, extendedMinutes: 0 });
  });
  it('retains exact legacy creation replay and defaults without rewriting its request', async () => {
    const { service } = fixture(), input = { scenarioId: 'monetary-validation', requestId: randomUUID(), targetMinutes: 45 };
    const original = await service.createSession('timing-owner', input);
    expect(await service.createSession('timing-owner', input)).toEqual(original);
    expect(original.session.configuration.practiceConditions).toBeUndefined();
    expect(timingConditions(original.session.configuration)).toMatchObject({ originalTargetMinutes: 45, targetMinutes: 45, extendedMinutes: 0, participation: 'text-or-voice' });
  });
  it('extends atomically, preserves work and original target, and replays before revision/lifecycle checks', async () => {
    const { service, store } = fixture(); const { session } = await start(service, { targetMinutes: 45 });
    const saved = await service.saveWorkspace('timing-owner', session.id, { requestId: randomUUID(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': session.files['quote.py'] + '\n# saved learner work\n' } });
    const before = await service.exportSession('timing-owner', session.id), requestId = randomUUID();
    const first = await extend(service, session.id, saved.session.revision, 30, requestId);
    expect(first.session.configuration).toMatchObject({ originalTargetMinutes: 45, targetMinutes: 75 });
    expect(first.session.files).toEqual(saved.session.files); expect(first.session.usage).toEqual(before.usage);
    expect((await store.read()).ledger).toHaveLength(1); expect(first.session.jobs).toEqual([]);
    expect(first.session.events.at(-1)).toMatchObject({ type: 'session.timing-extended', source: 'learner', requestId, payload: { additionalMinutes: 30, previousTargetMinutes: 45, targetMinutes: 75, originalTargetMinutes: 45 } });
    expect((await service.exportSession('timing-owner', session.id)).snapshots).toEqual(before.snapshots);
    await store.transaction(db => { db.sessions[session.id].lifecycle = 'completed'; });
    expect(await extend(service, session.id, 0, 30, requestId)).toEqual(first);
    await expect(extend(service, session.id, first.session.revision, 15, requestId)).rejects.toMatchObject({ code: 'conflict' });
    await expect(extend(service, session.id, first.session.revision)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('keeps owner checks, changed-body conflict and erased-request precedence', async () => {
    const { service } = fixture(), { session } = await start(service), requestId = randomUUID();
    await extend(service, session.id, session.revision, 15, requestId);
    await expect(service.extendTiming('other-owner', session.id, { requestId, expectedRevision: 1, additionalMinutes: 15 })).rejects.toMatchObject({ code: 'not_found' });
    await service.deleteSession('timing-owner', session.id, { requestId: randomUUID() });
    await expect(extend(service, session.id, session.revision, 15, requestId)).rejects.toMatchObject({ code: 'request_deleted' });
    await expect(extend(service, session.id, session.revision, 30, requestId)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allows paused and code-frozen debrief extensions but keeps submitted evidence and conditions fixed', async () => {
    const { service, store } = fixture(), { session } = await start(service);
    const paused = await service.command('timing-owner', session.id, { requestId: randomUUID(), expectedRevision: session.revision, action: 'pause' });
    const extended = await extend(service, session.id, paused.session.revision);
    expect(extended.session.lifecycle).toBe('paused');
    await store.transaction(db => { const s = db.sessions[session.id]; s.lifecycle = 'active'; s.stageId = 'debrief'; s.codeFrozenSnapshotId = s.snapshots.at(-1)!.id; });
    const debrief = await extend(service, session.id, extended.session.revision);
    expect(debrief.session.codeFrozenSnapshotId).toBeTruthy();
    await store.transaction(db => { const s = db.sessions[session.id]; s.frozenEvidence = freezeEvidence(s, s.updatedAt); s.lifecycle = 'reviewing'; });
    const frozen = await service.exportSession('timing-owner', session.id);
    await expect(extend(service, session.id, debrief.session.revision)).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.exportSession('timing-owner', session.id)).frozenEvidence).toEqual(frozen.frozenEvidence);
    expect((await service.getSession('timing-owner', session.id)).configuration).toEqual(frozen.configuration);
  });
  it('does not end work at the advisory cap and serializes competing revisions', async () => {
    const { service } = fixture(), { session } = await start(service, { targetMinutes: 165 });
    const results = await Promise.allSettled([extend(service, session.id, session.revision), extend(service, session.id, session.revision)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const current = await service.getSession('timing-owner', session.id); expect(current.configuration.targetMinutes).toBe(180);
    await expect(extend(service, session.id, current.revision)).rejects.toMatchObject({ code: 'conflict' });
    const saved = await service.saveWorkspace('timing-owner', session.id, { requestId: randomUUID(), expectedRevision: current.revision, files: current.files });
    expect(saved.session.lifecycle).toBe('active'); expect(describeTiming(saved.session.configuration)).toContain('do not lower rubric ratings');
  });
  it('derives the original target once for saved legacy sessions and validates persisted arithmetic', async () => {
    const { service, store } = fixture(), { session } = await start(service, { targetMinutes: 45 });
    await store.transaction(db => { delete db.sessions[session.id].configuration.originalTargetMinutes; });
    const first = await extend(service, session.id, session.revision), second = await extend(service, session.id, first.session.revision);
    expect(second.session.configuration).toMatchObject({ originalTargetMinutes: 45, targetMinutes: 75 });
    const event = second.session.events.at(-1)!;
    expect(() => parsePracticeEvent({ ...event, payload: { ...event.payload, targetMinutes: 74 } })).toThrow('Practice event does not match');
    expect(() => parsePracticeEvent({ ...event, source: 'model' })).toThrow('Practice event does not match');
  });
  it('records typed choices in progression without producing a rating or a weakness from timing', async () => {
    const { service } = fixture(), { session } = await start(service, { targetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' } });
    const extended = await extend(service, session.id, session.revision);
    const progress = buildProgression([extended.session], listScenarios().map(toPublicScenario));
    expect(progress.skills).toEqual([]); expect(progress.details.assessedAttempts).toBe(0);
    expect(timingConditions(extended.session.configuration)).toMatchObject({ originalTargetMinutes: 60, targetMinutes: 75, extendedMinutes: 15, setupExtraMinutes: 15, participation: 'written-only', recordedConditionCount: 2 });
  });
});
