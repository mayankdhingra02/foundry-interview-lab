import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../lib/interview-practice/types';
import { budgetTotals, reservationBudgetAt } from '../lib/interview-practice/quota';
import { SessionService, type ServiceOptions } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { reserveVoice, settleVoice } from '../lib/voice/ledger';
import type { VoiceConfig } from '../lib/voice/config';
import { scenario } from './review-fixtures';

const prior = '2026-10-31T23:59:50.000Z', next = '2026-11-01T00:00:01.000Z';
const posting = (operationId: string, kind: LedgerEntry['kind'], amountUsd: number, createdAt: string, extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: randomUUID(), ownerId: 'owner-a', sessionId: 'session-a', operationId, kind, amountUsd, createdAt, ...extra });
const totals = (ledger: LedgerEntry[], at = next, owner = 'owner-a') => budgetTotals(ledger, owner, at);
describe('reservation-owned UTC budget windows', () => {
  it('attributes a late negative settlement to the prior UTC day and month, preserving posting time', () => {
    const reserve = posting('job:1:reserve','reservation',.08,prior,{ budgetAt: prior });
    const settle = posting('job:1:settle','settlement',-.06,next,{ budgetAt: prior });
    const current = posting('new-job:1:reserve','reservation',.08,next,{ budgetAt: next });
    expect(totals([reserve,settle,current])).toEqual({ userDailyUsd: .08, userMonthlyUsd: .08, globalDailyUsd: .08 });
    expect(totals([reserve,settle,current],prior).userDailyUsd).toBeCloseTo(.02); expect(settle.createdAt).toBe(next);
  });
  it('reconstructs legacy reservations and settlements without budgetAt or reservation sequence', () => {
    const ledger = [posting('legacy-job:reserve','reservation',.08,prior),posting('legacy-job:settle','settlement',-.06,next),posting('new:1:reserve','reservation',.08,next)];
    expect(totals(ledger).userDailyUsd).toBe(.08); expect(totals(ledger,prior).userMonthlyUsd).toBeCloseTo(.02);
    expect(reservationBudgetAt(ledger,{ ownerId: 'owner-a', sessionId: 'session-a', operationId: 'legacy-job:reserve' })).toBe(prior);
  });
  it('binds retries to their full sequence rather than the first reservation for a job', () => {
    const ledger = [posting('job:1:reserve','reservation',.08,prior),posting('job:1:uncertain','uncertain',0,next),posting('job:2:reserve','reservation',.08,next),posting('job:2:settle','settlement',-.06,next)];
    expect(totals(ledger,prior).userDailyUsd).toBe(.08); expect(totals(ledger).userDailyUsd).toBeCloseTo(.02);
    expect(reservationBudgetAt(ledger,{ ownerId: 'owner-a', sessionId: 'session-a', operationId: 'job:2:reserve' })).toBe(next);
  });
  it.each([{ ownerId: 'owner-b' },{ sessionId: 'other-session' },{ operationId: 'job:2:settle' }])('never links a credit across owner, session, or sequence: %j', mismatch => {
    const reserve = posting('job:1:reserve','reservation',.08,prior), credit = posting('job:1:settle','settlement',-.08,next,mismatch);
    const current = posting('current:1:reserve','reservation',.08,next);
    expect(totals([reserve,credit,current]).userDailyUsd).toBe(.08); expect(totals([reserve,credit,current]).globalDailyUsd).toBe(.08);
  });
  it('ignores orphan negative settlements and counts orphan positive charges at their actual posting time', () => {
    const ledger = [posting('missing:1:settle','settlement',-10,next,{ budgetAt: prior }), posting('another:1:settle','settlement',.04,next,{ budgetAt: prior }), posting('current:1:reserve','reservation',.08,next)];
    expect(totals(ledger).userDailyUsd).toBeCloseTo(.12); expect(totals(ledger,prior).userDailyUsd).toBe(0);
  });
  it('does not trust an unmatched or misleading terminal budgetAt to redirect a credit', () => {
    const reserve = posting('job:1:reserve','reservation',.08,prior), settle = posting('job:1:settle','settlement',-.06,next,{ budgetAt: next });
    expect(totals([reserve,settle]).userDailyUsd).toBe(0); expect(totals([reserve,settle],prior).userDailyUsd).toBeCloseTo(.02);
  });
  it('never releases uncertain commitments or applies duplicate terminal credits', () => {
    const reserve = posting('job:1:reserve','reservation',.08,prior), credit = posting('job:1:settle','settlement',-.08,next);
    expect(totals([reserve,credit,posting('job:1:uncertain','uncertain',0,next)],prior).userDailyUsd).toBe(.08);
    expect(totals([reserve,credit,{ ...credit,id: randomUUID() }],prior).userDailyUsd).toBe(.08);
    expect(totals([reserve,{ ...reserve,id: randomUUID() },credit],prior).userDailyUsd).toBe(.16);
  });
  it('bounds a matched refund to its own reservation so other usage cannot be erased', () => {
    const ledger = [posting('job:1:reserve','reservation',.08,prior),posting('job:1:settle','settlement',-10,next),posting('other:1:reserve','reservation',.04,prior)];
    expect(totals(ledger,prior).userDailyUsd).toBeCloseTo(.04);
  });
  it('normalizes legacy offset timestamps to UTC instead of slicing their local clock date', () => {
    const ledger = [posting('job:1:reserve','reservation',.08,'2026-10-31T20:30:00-04:00'), posting('job:1:settle','settlement',-.06,'2026-11-01T01:00:00Z')];
    expect(totals(ledger).userMonthlyUsd).toBeCloseTo(.02); expect(totals(ledger,prior).userMonthlyUsd).toBe(0);
  });
  it('fails closed on invalid money/timestamps or reservation metadata that moves the budget window', () => {
    for (const entry of [posting('job:1:reserve','reservation',NaN,prior), posting('job:1:reserve','reservation',.08,'invalid'), posting('job:1:reserve','reservation',.08,prior,{ budgetAt: next })]) expect(() => totals([entry])).toThrow('operator review');
  });
});

function setup(at: string, options: ServiceOptions = {}) {
  const clock = { value: new Date(at) }, store = new MemoryPracticeStore();
  const service = new SessionService(store, () => structuredClone(scenario), { now: () => clock.value, maxSessionUsd: 10, maxDailyUsd: 10, maxMonthlyUsd: 100, maxGlobalDailyUsd: 100, ...options });
  const create = async (ownerId = 'owner-a') => (await service.createSession(ownerId,{ scenarioId: scenario.id, requestId: randomUUID() })).session;
  const request = async (id: string, ownerId = 'owner-a') => { const session = await service.getSession(ownerId,id); return service.requestAssistant(ownerId,id,{ requestId: randomUUID(), expectedRevision: session.revision, mode: 'ask', message: 'Explain this code.' }); };
  return { clock, store, service, create, request };
}
async function boundarySettlement(context: ReturnType<typeof setup>, legacy = false) {
  const session = await context.create(); await context.request(session.id); const claim = await context.service.claimJob('fixture-worker');
  if (legacy) await context.store.transaction(db => { for (const entry of db.ledger) delete entry.budgetAt; });
  const startedAt = context.clock.value.toISOString(); context.clock.value = new Date(next);
  const inference = { requestedModel: 'fixture', returnedModel: 'fixture', promptVersion: 'fixture', inputTokens: 10, outputTokens: 10, startedAt, completedAt: next, usd: .02, validated: true };
  expect(await context.service.completeJob(claim!,{ kind: 'assistant', model: 'synthetic-fixture', message: 'Synthetic response.', actualUsd: .02, inference })).toBe(true);
  return { session, claim: claim!, inference };
}
describe('atomic AI and speech quota admission across UTC boundaries', () => {
  it.each([false,true])('keeps late refunds from increasing the new-day AI allowance; legacy=%s', async legacy => {
    const context = setup(prior,{ maxDailyUsd: .1 }); await boundarySettlement(context,legacy);
    const first = await context.create(); await context.request(first.id); const second = await context.create();
    await expect(context.request(second.id)).rejects.toMatchObject({ code: 'quota' });
    expect(totals((await context.store.read()).ledger).userDailyUsd).toBe(.08);
  });
  it('enforces the monthly cap independently of a generous daily cap after a month-boundary refund', async () => {
    const context = setup(prior,{ maxMonthlyUsd: .1 }); await boundarySettlement(context);
    const first = await context.create(); await context.request(first.id); const second = await context.create();
    await expect(context.request(second.id)).rejects.toMatchObject({ code: 'quota' });
  });
  it('keeps a prior-owner refund from increasing another owner global daily admission', async () => {
    const context = setup(prior,{ maxGlobalDailyUsd: .1 }); await boundarySettlement(context);
    const first = await context.create('owner-b'); await context.request(first.id,'owner-b'); const second = await context.create('owner-c');
    await expect(context.request(second.id,'owner-c')).rejects.toMatchObject({ code: 'quota' });
  });
  it('preserves actual posting and inference clocks while adding reservation-owned budgetAt', async () => {
    const context = setup(prior), { session, claim, inference } = await boundarySettlement(context,true), db = await context.store.read();
    const settlement = db.ledger.find(entry => entry.operationId === `${claim.job.id}:1:settle`)!;
    expect(settlement.createdAt).toBe(next); expect(settlement.budgetAt).toBe(prior);
    expect((await context.service.exportSession('owner-a',session.id)).jobs.find(job => job.id === claim.job.id)!.inference).toEqual(inference);
  });
  it('marks uncertain old work and settles the retry against its own new reservation sequence', async () => {
    const before = '2026-10-31T23:59:59.500Z', context = setup(before,{ leaseMs: 1000 }), session = await context.create();
    await context.request(session.id); const first = await context.service.claimJob('first-worker'); context.clock.value = new Date(next);
    const second = await context.service.claimJob('retry-worker'); expect(second!.job.reservationSequence).toBe(2);
    expect(await context.service.completeJob(first!,{ kind: 'assistant', model: 'fixture', message: 'Stale', actualUsd: 0 })).toBe(false);
    await context.service.completeJob(second!,{ kind: 'assistant', model: 'fixture', message: 'Current', actualUsd: .02 });
    const db = await context.store.read(); expect(db.ledger.find(entry => entry.operationId === `${first!.job.id}:1:uncertain`)?.budgetAt).toBe(before);
    expect(db.ledger.find(entry => entry.operationId === `${first!.job.id}:2:settle`)?.budgetAt).toBe(next);
    expect(totals(db.ledger,before).userDailyUsd).toBe(.08); expect(totals(db.ledger).userDailyUsd).toBeCloseTo(.02);
  });
  it('retains correct cross-window accounting after Lab data deletion and recreation', async () => {
    const context = setup(prior,{ maxDailyUsd: .1 }); await boundarySettlement(context);
    const current = await context.create(); await context.request(current.id); const claim = await context.service.claimJob('current-worker');
    await context.service.completeJob(claim!,{ kind: 'assistant', model: 'fixture', message: 'Current', actualUsd: .08 });
    await context.service.deleteAccount('owner-a',{ requestId: randomUUID() }); expect(await context.service.listSessions('owner-a')).toEqual([]);
    const recreated = await context.create(); await expect(context.request(recreated.id)).rejects.toMatchObject({ code: 'quota' }); expect(totals((await context.store.read()).ledger).userDailyUsd).toBe(.08);
  });
  const voiceConfig: VoiceConfig = { apiKey: 'synthetic-not-a-key', sttUsdPerMinute: .0043, ttsUsdPerThousandChars: .03, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 600, sessionUsd: 10, userDailyUsd: .1, userMonthlyUsd: 100, globalDailyUsd: 100 };
  const voiceInput = (sessionId: string, ownerId = 'owner-a') => ({ sessionId, ownerId, requestId: randomUUID(), operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 1, characters: 0, usd: .08 });
  it('uses the same USD helper for voice so late AI refunds cannot fund extra speech', async () => {
    const context = setup(prior), { session } = await boundarySettlement(context), first = await reserveVoice(context.store,voiceConfig,voiceInput(session.id),context.clock.value);
    await settleVoice(context.store,first,false,context.clock.value);
    await expect(reserveVoice(context.store,voiceConfig,voiceInput(session.id),context.clock.value)).rejects.toMatchObject({ code: 'quota' });
    expect(totals((await context.store.read()).ledger).userDailyUsd).toBe(.08);
  });
  it('enforces shared monthly speech spend across days independently of the daily limit', async () => {
    const context = setup('2026-10-30T12:00:00.000Z'), session = await context.create();
    await context.request(session.id); const claim = await context.service.claimJob('fixture-worker');
    await context.service.completeJob(claim!, { kind: 'assistant', model: 'synthetic-fixture', message: 'Synthetic answer.', actualUsd: .08 });
    context.clock.value = new Date('2026-10-31T12:00:00.000Z');
    const config = { ...voiceConfig, userDailyUsd: 10, userMonthlyUsd: .1 };
    await expect(reserveVoice(context.store, config, voiceInput(session.id), context.clock.value)).rejects.toMatchObject({ code: 'quota' });
    expect(totals((await context.store.read()).ledger, context.clock.value.toISOString())).toMatchObject({ userDailyUsd: 0, userMonthlyUsd: .08 });
    context.clock.value = new Date(next);
    await expect(reserveVoice(context.store, config, voiceInput(session.id), context.clock.value)).resolves.toHaveProperty('key');
  });
  it('keeps the shared global speech cap across owners despite prior-window AI settlements', async () => {
    const context = setup(prior); await boundarySettlement(context); const a = await context.create('owner-b'), b = await context.create('owner-c'), config = { ...voiceConfig,userDailyUsd: 10,globalDailyUsd: .1 };
    const first = await reserveVoice(context.store,config,voiceInput(a.id,'owner-b'),context.clock.value); await settleVoice(context.store,first,false,context.clock.value);
    await expect(reserveVoice(context.store,config,voiceInput(b.id,'owner-c'),context.clock.value)).rejects.toMatchObject({ code: 'quota' });
  });
  it('retains voice reservation budgetAt on a zero-value terminal posting after midnight', async () => {
    const context = setup(prior), session = await context.create(), reservation = await reserveVoice(context.store,voiceConfig,voiceInput(session.id),context.clock.value);
    context.clock.value = new Date(next); await settleVoice(context.store,reservation,true,context.clock.value);
    const terminal = (await context.store.read()).ledger.find(entry => entry.operationId === `${reservation.key}:uncertain`)!;
    expect(terminal.createdAt).toBe(next); expect(terminal.budgetAt).toBe(prior); expect(terminal.amountUsd).toBe(0);
    expect(totals((await context.store.read()).ledger).userDailyUsd).toBe(0); expect(totals((await context.store.read()).ledger,prior).userDailyUsd).toBe(.08);
  });
});
