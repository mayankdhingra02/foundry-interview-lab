import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { budgetTotals, ledgerBudgetGroupKey } from '../lib/interview-practice/quota';
import type { LedgerEntry } from '../lib/interview-practice/types';
import { SessionService, type ServiceOptions } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { reserveVoice, settleVoice } from '../lib/voice/ledger';
import type { VoiceConfig } from '../lib/voice/config';
import { scenario } from './review-fixtures';

const at = '2026-10-09T12:00:00.000Z';
function setup(options: ServiceOptions = {}) {
  const store = new MemoryPracticeStore();
  const service = new SessionService(store, () => structuredClone(scenario), { now: () => new Date(at), maxDailySessions: 20, maxActiveSessions: 10, maxDailyUsd: .08, maxMonthlyUsd: .08, ...options });
  const create = async (owner = 'owner-a') => (await service.createSession(owner, { scenarioId: scenario.id, requestId: randomUUID() })).session;
  const request = async (id: string, owner = 'owner-a') => service.requestAssistant(owner, id, { requestId: randomUUID(), expectedRevision: (await service.getSession(owner, id)).revision, mode: 'ask', message: 'PRIVATE-ASSISTANT-PROMPT' });
  return { store, service, create, request };
}
function group(entries: LedgerEntry[], jobId: string) {
  const reservation = entries.find(entry => entry.operationId === `${jobId}:1:reserve`)!;
  return entries.filter(entry => ledgerBudgetGroupKey(entry) === ledgerBudgetGroupKey(reservation));
}

describe('content-free accounting during private attempt erasure', () => {
  it('releases queued work exactly once and erases its payload and cached result', async () => {
    const { store, service, create, request } = setup();
    const session = await create(), result = await request(session.id), jobId = result.job!.id, deleteKey = randomUUID();
    await service.deleteSession('owner-a', session.id, { requestId: deleteKey });
    const database = await store.read(), postings = group(database.ledger, jobId);
    expect(postings.map(entry => entry.kind)).toEqual(['reservation', 'settlement']);
    expect(postings[1]).toMatchObject({ amountUsd: -.08, budgetAt: at, createdAt: at });
    expect(budgetTotals(database.ledger, 'owner-a', at).userMonthlyUsd).toBe(0);
    expect(database.sessions[session.id]).toBeUndefined();
    expect(JSON.stringify(database)).not.toContain('PRIVATE-ASSISTANT-PROMPT');
    expect(JSON.stringify(database)).not.toContain('PRIVATE-LEARNER-CODE');
    expect(await service.deleteSession('owner-a', session.id, { requestId: deleteKey })).toEqual({ deleted: true });
    expect((await store.read()).ledger).toEqual(database.ledger);
    const next = await create(); await expect(request(next.id)).resolves.toHaveProperty('job');
  });

  it('keeps running work uncertain, blocks a recreated attempt and fences every stale worker path', async () => {
    const { store, service, create, request } = setup();
    const session = await create(); await request(session.id); const claim = (await service.claimJob('fixture-worker'))!;
    await service.deleteSession('owner-a', session.id, { requestId: randomUUID() });
    const database = await store.read(), postings = group(database.ledger, claim.job.id);
    expect(postings.map(entry => entry.kind)).toEqual(['reservation', 'uncertain']);
    expect(postings[1]).toMatchObject({ amountUsd: 0, budgetAt: at });
    expect(budgetTotals(database.ledger, 'owner-a', at)).toMatchObject({ userDailyUsd: .08, userMonthlyUsd: .08 });
    expect(await service.heartbeatJob(claim)).toBe(false);
    expect(await service.completeJob(claim, { kind: 'assistant', model: 'synthetic-fixture', message: 'PRIVATE-LATE-RESPONSE', actualUsd: 0 })).toBe(false);
    expect(await service.failJob(claim, 'PRIVATE-LATE-ERROR', 0)).toBe(false);
    expect(await service.claimJob('replacement-worker')).toBeNull();
    expect((await store.read()).ledger).toEqual(database.ledger);
    expect(JSON.stringify(await store.read())).not.toContain('PRIVATE-');
    const next = await create(); await expect(request(next.id)).rejects.toMatchObject({ code: 'quota' });
  });

  it.each(['completed', 'cancelled', 'failed'] as const)('does not append another terminal posting for a %s job', async state => {
    const { store, service, create, request } = setup(); const session = await create(), result = await request(session.id);
    if (state === 'cancelled') await service.cancelJob('owner-a', result.job!.id, { requestId: randomUUID() });
    else {
      const claim = (await service.claimJob('fixture-worker'))!;
      if (state === 'completed') await service.completeJob(claim, { kind: 'assistant', model: 'synthetic-fixture', message: 'A synthetic answer.', actualUsd: .02 });
      else await service.failJob(claim, 'Synthetic failure', 0);
    }
    const before = (await store.read()).ledger;
    await service.deleteSession('owner-a', session.id, { requestId: randomUUID() });
    expect((await store.read()).ledger).toEqual(before);
  });

  it('uses the same queued/running/terminal treatment for Lab account erasure without touching another owner', async () => {
    const { store, service, create, request } = setup({ maxDailyUsd: 1, maxMonthlyUsd: .1 });
    const completed = await create(); await request(completed.id); const done = (await service.claimJob('fixture-worker'))!;
    await service.completeJob(done, { kind: 'assistant', model: 'synthetic-fixture', message: 'A synthetic answer.', actualUsd: .02 });
    const running = await create(); await request(running.id); const claim = (await service.claimJob('fixture-worker'))!;
    // Queue a zero-cost run alongside running AI, and separately queued AI on
    // another owner. The latter must remain untouched by this account erasure.
    await service.requestRun('owner-a', running.id, { requestId: randomUUID(), expectedRevision: (await service.getSession('owner-a', running.id)).revision });
    const other = await create('owner-b'); await request(other.id, 'owner-b');
    const completedGroup = group((await store.read()).ledger, done.job.id);
    await service.deleteAccount('owner-a', { requestId: randomUUID() });
    const database = await store.read();
    expect(await service.listSessions('owner-a')).toEqual([]);
    expect((await service.getSession('owner-b', other.id)).jobs[0].state).toBe('queued');
    expect(group(database.ledger, done.job.id)).toEqual(completedGroup);
    expect(group(database.ledger, claim.job.id).map(entry => entry.kind)).toEqual(['reservation', 'uncertain']);
    expect(database.ledger.filter(entry => entry.ownerId === 'owner-a' && entry.kind === 'admission')).toHaveLength(2);
    expect(budgetTotals(database.ledger, 'owner-a', at).userMonthlyUsd).toBeCloseTo(.1);
    expect(await service.completeJob(claim, { kind: 'assistant', model: 'synthetic-fixture', message: 'Late', actualUsd: 0 })).toBe(false);
    const next = await create(); await expect(request(next.id)).rejects.toMatchObject({ code: 'quota' });
  });

  it('keeps daily admission counters after queued reservations are legitimately released', async () => {
    const { store, service, create, request } = setup({ maxDailySessions: 1 });
    const session = await create(); await request(session.id);
    await service.deleteAccount('owner-a', { requestId: randomUUID() });
    expect(budgetTotals((await store.read()).ledger, 'owner-a', at).userDailyUsd).toBe(0);
    await expect(create()).rejects.toMatchObject({ code: 'quota' });
  });

  it('releases a positive queued AI reservation during account erasure', async () => {
    const { store, service, create, request } = setup();
    const session = await create(), result = await request(session.id);
    await service.deleteAccount('owner-a', { requestId: randomUUID() });
    expect(group((await store.read()).ledger, result.job!.id).map(entry => entry.kind)).toEqual(['reservation', 'settlement']);
    expect(budgetTotals((await store.read()).ledger, 'owner-a', at).userMonthlyUsd).toBe(0);
    const next = await create(); await expect(request(next.id)).resolves.toHaveProperty('job');
  });

  it('holds a pending voice reservation through deletion and only records the actual uncertain callback', async () => {
    const { store, service, create } = setup(), session = await create();
    const config: VoiceConfig = { apiKey: 'synthetic-not-a-key', sttUsdPerMinute: .0043, ttsUsdPerThousandChars: .03, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 600, sessionUsd: 1, userDailyUsd: .08, userMonthlyUsd: .08, globalDailyUsd: 50 };
    const input = { sessionId: session.id, ownerId: 'owner-a', requestId: randomUUID(), operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 1, characters: 0, usd: .08 };
    const reservation = await reserveVoice(store, config, input, new Date(at));
    await service.deleteSession('owner-a', session.id, { requestId: randomUUID() });
    const pending = (await store.read()).ledger.filter(entry => entry.operationId.startsWith(reservation.key));
    expect(pending.map(entry => entry.kind)).toEqual(['reservation']);
    const next = await create();
    await expect(reserveVoice(store, config, { ...input, sessionId: next.id, requestId: randomUUID() }, new Date(at))).rejects.toMatchObject({ code: 'quota' });
    expect(await settleVoice(store, reservation, true, new Date(at))).toBe(false);
    expect(await settleVoice(store, reservation, false, new Date(at))).toBe(false);
    const database = await store.read();
    expect(database.ledger.filter(entry => entry.operationId.startsWith(reservation.key)).map(entry => entry.kind)).toEqual(['reservation', 'uncertain']);
    expect(budgetTotals(database.ledger, 'owner-a', at).userMonthlyUsd).toBe(.08);
    expect(database.sessions[session.id]).toBeUndefined();
    expect(JSON.stringify(database.ledger)).not.toContain('PRIVATE-');
  });
});
