import { completeFixtureJob } from './inference-fixtures';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { admissionLimits, admissionLimitsFromEnvironment, DEFAULT_ADMISSION_LIMITS } from '../lib/interview-practice/admission';
import { observationOnlyReport } from '../lib/ai/provider';
import { SessionService, type ServiceOptions } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { InteractionService } from '../lib/server/interactions';
import { ReviewService } from '../lib/server/review-service';
import { scenario } from './review-fixtures';

const start = '2026-10-09T12:00:00.000Z';
function setup(options: ServiceOptions = {}) {
  const store = new MemoryPracticeStore(), clock = { value: new Date(start) };
  const service = new SessionService(store, () => structuredClone(scenario), { now: () => clock.value, maxActiveSessions: 100, maxDailySessions: 100, maxSessionUsd: 10, maxDailyUsd: 100, maxMonthlyUsd: 1000, maxGlobalDailyUsd: 1000, ...options });
  const create = (owner = 'owner-a', requestId = randomUUID()) => service.createSession(owner, { scenarioId: scenario.id, requestId });
  const assist = async (id: string, owner = 'owner-a', requestId = randomUUID()) => {
    const session = await service.getSession(owner, id);
    return service.requestAssistant(owner, id, { requestId, expectedRevision: session.revision, mode: 'ask', message: 'Explain the public contract.' });
  };
  const save = async (id: string, code: string, owner = 'owner-a', requestId = randomUUID()) => {
    const session = await service.getSession(owner, id);
    return service.saveWorkspace(owner, id, { requestId, expectedRevision: session.revision, files: { ...session.files, 'main.py': code } });
  };
  return { store, clock, service, create, assist, save };
}

describe('shared owner mutation windows and exact replay', () => {
  it('returns acknowledged creation at the request and rate ceiling without another entitlement callback', async () => {
    const admissionPolicy = vi.fn(async () => {}), context = setup({ admissionLimits: { ownerMutationsPerMinute: 1, ownerRequests: 1 }, admissionPolicy }), key = randomUUID();
    const original = await context.create('owner-a', key);
    expect(await context.create('owner-a', key)).toEqual(original); expect(admissionPolicy).toHaveBeenCalledTimes(1);
    await expect(context.create()).rejects.toMatchObject({ code: 'quota' }); expect(admissionPolicy).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent same-owner admission across independent service instances', async () => {
    const context = setup({ admissionLimits: { ownerMutationsPerMinute: 1 } });
    const second = new SessionService(context.store, () => structuredClone(scenario), { now: () => context.clock.value, admissionLimits: { ownerMutationsPerMinute: 1 } });
    const results = await Promise.allSettled([context.create(), second.createSession('owner-a', { scenarioId: scenario.id, requestId: randomUUID() })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(Object.keys((await context.store.read()).sessions)).toHaveLength(1);
    expect(await context.create('owner-b')).toBeDefined();
  });
  it('expires the rolling minute at the exact lower boundary', async () => {
    const context = setup({ admissionLimits: { ownerMutationsPerMinute: 1 } }), { session } = await context.create();
    context.clock.value = new Date(Date.parse(start) + 59_999); await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' });
    context.clock.value = new Date(Date.parse(start) + 60_000); expect((await context.assist(session.id)).job?.state).toBe('queued');
  });
  it('enforces a rolling 24-hour window independently of the minute and UTC-day boundary', async () => {
    const context = setup({ admissionLimits: { ownerMutationsPerDay: 1 } }), { session } = await context.create();
    context.clock.value = new Date('2026-10-10T00:00:00.000Z'); await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' });
    context.clock.value = new Date(Date.parse(start) + 86_400_000); expect((await context.assist(session.id)).job).toBeDefined();
  });
  it('keeps the workspace save lane available after ordinary actions reach their ceiling', async () => {
    const context = setup({ admissionLimits: { ownerMutationsPerMinute: 1, ownerSavesPerMinute: 2 } }), { session } = await context.create();
    await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' });
    await context.save(session.id, 'first acknowledged change'); await context.save(session.id, 'second acknowledged change');
    const before = await context.store.read(); await expect(context.save(session.id, 'unacknowledged draft')).rejects.toMatchObject({ code: 'quota' }); expect(await context.store.read()).toEqual(before);
  });
  it('enforces the separate rolling daily save allowance', async () => {
    const context = setup({ admissionLimits: { ownerSavesPerDay: 1 } }), { session } = await context.create(); await context.save(session.id, 'saved once');
    context.clock.value = new Date(Date.parse(start) + 60_000); await expect(context.save(session.id, 'not saved')).rejects.toMatchObject({ code: 'quota' });
    context.clock.value = new Date(Date.parse(start) + 86_400_000); await context.save(session.id, 'saved after full day');
  });
  it('does not disclose foreign or nonexistent sessions through capacity diagnostics', async () => {
    const context = setup({ admissionLimits: { ownerRequests: 1 } }); await context.create('owner-a'); const other = await context.create('owner-b');
    const input = { requestId: randomUUID(), expectedRevision: 0, files: scenario.files };
    await expect(context.service.saveWorkspace('owner-a', other.session.id, input)).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(context.service.saveWorkspace('owner-a', randomUUID(), input)).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });
  it('counts unknown recent legacy request lanes conservatively and fails closed on invalid admission clocks', async () => {
    const context = setup({ admissionLimits: { ownerMutationsPerMinute: 1 } }), { session } = await context.create();
    await context.store.transaction(db => { const record = Object.values(db.requests)[0] as typeof db.requests[string] & { admission?: unknown }; delete record.admission; });
    await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' });
    await context.store.transaction(db => { Object.values(db.requests)[0].createdAt = 'invalid'; });
    await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await context.service.deleteAccount('owner-a', { requestId: randomUUID() })).toEqual({ deleted: true });
  });
});

describe('retained history and immutable evidence capacity', () => {
  it('exempts actual account erasure but bounds fresh no-op deletion keys after erasure', async () => {
    const context = setup({ admissionLimits: { ownerRequests: 1, ownerMutationsPerMinute: 1 } }); await context.create();
    const key = randomUUID(); expect(await context.service.deleteAccount('owner-a', { requestId: key })).toEqual({ deleted: true });
    const before = await context.store.read(); expect(Object.values(before.sessions)).toHaveLength(0);
    expect(await context.service.deleteAccount('owner-a', { requestId: key })).toEqual({ deleted: true });
    await expect(context.service.deleteAccount('owner-a', { requestId: randomUUID() })).rejects.toMatchObject({ code: 'quota' });
    expect(await context.store.read()).toEqual(before);
  });
  it('checks saved attempt history before billing even when the previous attempt is completed', async () => {
    const admissionPolicy = vi.fn(async () => {}), context = setup({ admissionLimits: { ownerSessions: 1 }, admissionPolicy }), { session } = await context.create();
    await context.store.transaction(db => { db.sessions[session.id].lifecycle = 'completed'; });
    const before = await context.store.read(); await expect(context.create()).rejects.toMatchObject({ code: 'quota' });
    expect(admissionPolicy).toHaveBeenCalledTimes(1); expect(await context.store.read()).toEqual(before);
    await context.service.deleteSession('owner-a', session.id, { requestId: randomUUID() }); expect((await context.create()).session).toBeDefined();
  });
  it('rejects a new snapshot atomically while preserving all acknowledged versions and the exact replay', async () => {
    const context = setup({ admissionLimits: { sessionSnapshots: 2 } }), { session } = await context.create(), key = randomUUID();
    const saved = await context.save(session.id, 'acknowledged second snapshot', 'owner-a', key), before = await context.store.read();
    await expect(context.save(session.id, 'unacknowledged third snapshot')).rejects.toMatchObject({ code: 'quota' });
    expect(await context.store.read()).toEqual(before); expect(await context.save(session.id, 'acknowledged second snapshot', 'owner-a', key)).toEqual(saved);
    expect((await context.service.exportSession('owner-a', session.id)).snapshots).toHaveLength(2);
  });
  it('does not consume a provider reservation or cache response when the resulting event would exceed history capacity', async () => {
    const context = setup({ admissionLimits: { sessionEvents: 1 } }), { session } = await context.create(), before = await context.store.read();
    await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' }); expect(await context.store.read()).toEqual(before);
  });
  it('allows terminal recovery, worker completion, export and deletion when request/event ceilings are reached', async () => {
    const context = setup({ admissionLimits: { ownerRequests: 2, sessionEvents: 2 } }); let { session } = await context.create();
    const queued = await context.assist(session.id); await context.service.cancelJob('owner-a', queued.job!.id, { requestId: randomUUID() });
    await expect(context.service.cancelJob('owner-a', queued.job!.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'quota' });
    session = await context.service.getSession('owner-a', session.id);
    const finish = await context.service.command('owner-a', session.id, { action: 'finish', requestId: randomUUID(), expectedRevision: session.revision });
    await context.service.cancelJob('owner-a', finish.job!.id, { requestId: randomUUID() }); session = await context.service.getSession('owner-a', session.id);
    await context.service.command('owner-a', session.id, { action: 'submit', requestId: randomUUID(), expectedRevision: session.revision });
    const claim = await context.service.claimJob('fixture-worker'); expect(await context.service.heartbeatJob(claim!)).toBe(true);
    expect(await completeFixtureJob(context.service, claim!, { kind: 'coach', actualUsd: 0, model: 'authored-observation-only', promptVersion: 'foundry-2026-10-09-v2', report: observationOnlyReport(scenario) })).toBe(true);
    expect((await context.service.exportSession('owner-a', session.id)).reports).toHaveLength(1);
    expect(await context.service.deleteSession('owner-a', session.id, { requestId: randomUUID() })).toEqual({ deleted: true });
    expect(await context.service.deleteAccount('owner-a', { requestId: randomUUID() })).toEqual({ deleted: true });
  });
});

describe('global and per-owner queued/running job admission', () => {
  it('admits only one of concurrent owners at the shared ceiling with no losing-side debit', async () => {
    const context = setup({ admissionLimits: { globalInFlightJobs: 1 } }), a = await context.create('owner-a'), b = await context.create('owner-b');
    const results = await Promise.allSettled([context.assist(a.session.id, 'owner-a'), context.assist(b.session.id, 'owner-b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const db = await context.store.read(); expect(Object.values(db.sessions).flatMap(session => session.jobs)).toHaveLength(1); expect(db.ledger.filter(entry => entry.kind === 'reservation')).toHaveLength(1);
    const losing = results.findIndex(result => result.status === 'rejected'), losingId = [a.session.id, b.session.id][losing];
    expect(db.sessions[losingId].usage.reservedUsd).toBe(0); expect(db.sessions[losingId].assistantMessages).toHaveLength(0);
  });
  it('counts queued and running jobs across independent services, then admits after a genuine worker completion', async () => {
    const context = setup({ admissionLimits: { globalInFlightJobs: 1 } }), a = await context.create('owner-a'), b = await context.create('owner-b'); await context.assist(a.session.id);
    const claim = await context.service.claimJob('fixture-worker'); await expect(context.assist(b.session.id, 'owner-b')).rejects.toMatchObject({ code: 'quota' });
    const independent = new SessionService(context.store, () => structuredClone(scenario), { now: () => context.clock.value, admissionLimits: { globalInFlightJobs: 1 } });
    expect(await completeFixtureJob(independent, claim!, { kind: 'assistant', model: 'synthetic-fixture', message: 'Fixture completion.', actualUsd: .01 })).toBe(true);
    expect((await context.assist(b.session.id, 'owner-b')).job?.state).toBe('queued');
  });
  it('enforces an owner ceiling across attempts without blocking other owners or workspace saving', async () => {
    const context = setup({ admissionLimits: { ownerInFlightJobs: 1, globalInFlightJobs: 2 } }), a = await context.create(), second = await context.create(), b = await context.create('owner-b');
    await context.assist(a.session.id); await expect(context.assist(second.session.id)).rejects.toMatchObject({ code: 'quota' });
    await context.save(second.session.id, 'saved while processing is full'); expect((await context.assist(b.session.id, 'owner-b')).job).toBeDefined();
  });
  it('also bounds report requeues that reuse a terminal job rather than enqueue a new one', async () => {
    const context = setup({ admissionLimits: { globalInFlightJobs: 1 } }); let { session } = await context.create();
    const finish = await context.service.command('owner-a', session.id, { action: 'finish', requestId: randomUUID(), expectedRevision: session.revision });
    await context.service.cancelJob('owner-a', finish.job!.id, { requestId: randomUUID() }); session = await context.service.getSession('owner-a', session.id);
    await context.service.command('owner-a', session.id, { action: 'submit', requestId: randomUUID(), expectedRevision: session.revision });
    const failed = await context.service.claimJob('fixture-worker'); await context.service.failJob(failed!, 'Synthetic interruption', 0);
    const other = await context.create('owner-b'); await context.assist(other.session.id, 'owner-b'); const before = await context.store.read();
    await expect(context.service.retryReport('owner-a', session.id, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'quota' }); expect(await context.store.read()).toEqual(before);
  });
});

it('rejects invalid policy configuration without silently disabling a limit', () => {
  expect(admissionLimits()).toEqual(DEFAULT_ADMISSION_LIMITS);
  for (const value of [0, -1, 1.5, NaN, Infinity, 1_000_001]) expect(() => admissionLimits({ ownerRequests: value })).toThrow('positive bounded integers');
  expect(admissionLimitsFromEnvironment({ PRACTICE_MAX_GLOBAL_PENDING_JOBS: '7', PRACTICE_OWNER_SAVES_PER_MINUTE: '120' })).toMatchObject({ globalInFlightJobs: 7, ownerSavesPerMinute: 120 });
  expect(admissionLimitsFromEnvironment({ PRACTICE_MAX_OWNER_HISTORY: '' })).toEqual(DEFAULT_ADMISSION_LIMITS);
  for (const value of ['0', '-1', '1.5', 'Infinity', 'NaN', 'bad', '1e2', '0x10', ' 10 ', '1000001']) expect(() => admissionLimitsFromEnvironment({ PRACTICE_MAX_OWNER_REQUESTS: value })).toThrow('positive bounded integer');
});

describe('cross-service learner growth and consent recovery', () => {
  const supportInput = () => ({ requestId: randomUUID(), category: 'technical' as const, message: 'Synthetic support request.', inspectionConsent: true, supportActionsConsent: true });
  function services(context: ReturnType<typeof setup>, limits: ServiceOptions['admissionLimits']) {
    return {
      interactions: new InteractionService(context.store, () => context.clock.value, limits),
      reviews: new ReviewService(context.store, () => structuredClone(scenario), { now: () => context.clock.value, admissionLimits: limits, adminUserIds: ['staff-id'], practice: context.service }),
    };
  }
  it('shares the ordinary allowance with interview controls, preserving replay and ownership at capacity', async () => {
    const limits = { ownerMutationsPerMinute: 2, ownerRequests: 2 }, context = setup({ admissionLimits: limits }), { interactions } = services(context, limits), { session } = await context.create();
    const input = { requestId: randomUUID(), expectedRevision: session.revision, action: 'working' as const };
    const original = await interactions.interact('owner-a', session.id, input), before = await context.store.read();
    expect(await interactions.interact('owner-a', session.id, input)).toEqual(original);
    await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' });
    await expect(interactions.interact('owner-a', session.id, { ...input, requestId: randomUUID(), expectedRevision: original.session.revision })).rejects.toMatchObject({ code: 'quota' });
    await expect(interactions.interact('owner-b', session.id, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
    expect(await context.store.read()).toEqual(before);
  });
  it('rolls back control events and their caches when session evidence growth is full', async () => {
    const limits = { sessionEvents: 1 }, context = setup({ admissionLimits: limits }), { interactions } = services(context, limits), { session } = await context.create(), before = await context.store.read();
    await expect(interactions.interact('owner-a', session.id, { requestId: randomUUID(), expectedRevision: session.revision, action: 'working' })).rejects.toMatchObject({ code: 'quota' });
    expect(await context.store.read()).toEqual(before);
  });
  it('bounds support creation and new consent keys in the same owner request/rate lane', async () => {
    const limits = { ownerMutationsPerMinute: 2, ownerRequests: 2 }, context = setup({ admissionLimits: limits }), { reviews } = services(context, limits), { session } = await context.create(), input = supportInput();
    const item = await reviews.createCase('owner-a', session.id, input), before = await context.store.read();
    expect(await reviews.createCase('owner-a', session.id, input)).toEqual(item);
    await expect(reviews.setConsent('owner-a', item.id, { requestId: randomUUID(), expectedRevision: item.revision, inspectionConsent: true, supportActionsConsent: true })).rejects.toMatchObject({ code: 'quota' });
    await expect(reviews.createCase('owner-a', session.id, supportInput())).rejects.toMatchObject({ code: 'quota' });
    await expect(reviews.setConsent('owner-b', item.id, { requestId: randomUUID(), expectedRevision: item.revision, inspectionConsent: false, supportActionsConsent: false })).rejects.toMatchObject({ code: 'not_found' });
    expect(await context.store.read()).toEqual(before);
  });
  it('allows actual permission revocation at capacity, while no-op revocations and renewed grants remain bounded', async () => {
    const limits = { ownerRequests: 2, ownerMutationsPerMinute: 2 }, context = setup({ admissionLimits: limits }), { reviews } = services(context, limits), { session } = await context.create();
    const item = await reviews.createCase('owner-a', session.id, supportInput());
    const revoke = { requestId: randomUUID(), expectedRevision: item.revision, inspectionConsent: false, supportActionsConsent: false };
    const revoked = await reviews.setConsent('owner-a', item.id, revoke); expect(revoked).toMatchObject({ inspectionConsent: false, supportActionsConsent: false, consentExpiresAt: null });
    expect(await reviews.setConsent('owner-a', item.id, revoke)).toEqual(revoked);
    const before = await context.store.read();
    await expect(reviews.setConsent('owner-a', item.id, { ...revoke, requestId: randomUUID(), expectedRevision: revoked.revision })).rejects.toMatchObject({ code: 'quota' });
    await expect(reviews.setConsent('owner-a', item.id, { ...revoke, requestId: randomUUID(), expectedRevision: revoked.revision, inspectionConsent: true })).rejects.toMatchObject({ code: 'quota' });
    expect(await context.store.read()).toEqual(before); expect(before.reviews!.audits.filter(audit => audit.action === 'consent.changed')).toHaveLength(1);
    expect((await reviews.exportOwner('owner-a')).cases).toHaveLength(1);
    await context.service.deleteSession('owner-a', session.id, { requestId: randomUUID() }); expect((await reviews.exportOwner('owner-a')).cases).toHaveLength(0);
  });
  it('keeps authorized staff inspection caches and canonical audits separate from learner admission', async () => {
    const limits = { ownerMutationsPerMinute: 3, ownerRequests: 3 }, context = setup({ admissionLimits: limits }), { reviews, interactions } = services(context, limits), { session } = await context.create();
    const item = await reviews.createCase('owner-a', session.id, supportInput());
    await reviews.inspect({ id: 'staff-id', local: false }, item.id, { requestId: randomUUID(), purpose: 'Synthetic regression qualification.' });
    const result = await interactions.interact('owner-a', session.id, { requestId: randomUUID(), expectedRevision: session.revision, action: 'working' });
    expect(result.response).toContain('continue at your pace');
    const db = await context.store.read(); expect(db.reviews!.audits.some(audit => audit.action === 'content.inspected')).toBe(true); expect(Object.values(db.requests)).toHaveLength(4);
    await expect(context.assist(session.id)).rejects.toMatchObject({ code: 'quota' });
  });
  it('checks job ownership before capacity diagnostics for cancellation with a fresh key', async () => {
    const context = setup({ admissionLimits: { ownerRequests: 1 } }); await context.create('owner-a'); const foreign = await context.create('owner-b');
    const second = new SessionService(context.store, () => structuredClone(scenario)), pending = await second.requestAssistant('owner-b', foreign.session.id, { requestId: randomUUID(), expectedRevision: foreign.session.revision, mode: 'ask', message: 'Synthetic pending work.' });
    for (const jobId of [pending.job!.id, randomUUID()]) await expect(context.service.cancelJob('owner-a', jobId, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
  });
});
