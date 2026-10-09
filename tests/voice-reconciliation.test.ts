import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { budgetTotals } from '../lib/interview-practice/quota';
import { FilePracticeStore, MemoryPracticeStore, type PracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { reconcileVoiceReservations, reserveVoice, settleVoice, VOICE_RECONCILIATION_POLICY, type VoiceLedgerEntry } from '../lib/voice/ledger';
import { VoiceService } from '../lib/voice/provider';
import type { VoiceConfig } from '../lib/voice/config';
import { voiceDebriefFixture } from './voice-fixtures';

const at = new Date('2026-01-31T23:59:30.000Z'), expired = new Date(at.getTime() + VOICE_RECONCILIATION_POLICY.leaseMs);
const config: VoiceConfig = { apiKey: 'fixture-not-a-key', sttUsdPerMinute: .0043, ttsUsdPerThousandChars: .03, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 600, sessionUsd: 1, userDailyUsd: 5, userMonthlyUsd: 50, globalDailyUsd: 50 };
let store: MemoryPracticeStore, sessions: SessionService, sessionId: string;
const directories: string[] = [];
async function create(adapter: PracticeStore, ownerId = 'owner', now = at) {
  const service = new SessionService(adapter, getScenario, { now: () => now });
  const { session } = await service.createSession(ownerId, { scenarioId: 'monetary-validation', requestId: randomUUID(), voice: true });
  await voiceDebriefFixture(adapter, session.id); return session.id;
}
const input = (overrides = {}) => ({ ownerId: 'owner', sessionId, requestId: randomUUID(), operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 60, characters: 0, usd: .1, ...overrides });
const voiceRows = async (adapter: PracticeStore = store) => (await adapter.read()).ledger.filter(entry => 'voice' in entry) as VoiceLedgerEntry[];
beforeEach(async () => { store = new MemoryPracticeStore(); sessionId = await create(store); sessions = new SessionService(store, getScenario, { now: () => at }); });
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('bounded conservative voice reservation recovery', () => {
  it('persists a fixed 120-second expiry and dry-run does not modify any state', async () => {
    const reservation = await reserveVoice(store, config, input(), at), before = await store.read();
    expect(reservation.expiresAt).toBe(expired.toISOString()); expect((await voiceRows())[0].voice.expiresAt).toBe(expired.toISOString());
    expect((await reconcileVoiceReservations(store, { now: new Date(expired.getTime() - 1) })).expired).toBe(0);
    expect(await reconcileVoiceReservations(store, { now: expired })).toMatchObject({ mode: 'dry-run', pending: 1, expired: 1, selected: 1, reconciled: 0 });
    expect(await store.read()).toEqual(before);
  });
  it('retains cost, minutes and original UTC budget windows when marking uncertainty', async () => {
    const reservation = await reserveVoice(store, config, input(), at);
    expect(await reconcileVoiceReservations(store, { apply: true, now: expired })).toMatchObject({ reconciled: 1, moreEligible: false });
    const db = await store.read(), rows = await voiceRows();
    expect(rows.map(row => row.voice.state)).toEqual(['reserved', 'uncertain']);
    expect(rows[0].amountUsd).toBe(.1); expect(rows[1]).toMatchObject({ amountUsd: 0, createdAt: expired.toISOString(), budgetAt: at.toISOString() });
    expect(rows[1].voice).toMatchObject({ seconds: 60, reservedUsd: .1, expiresAt: expired.toISOString() });
    expect(db.sessions[sessionId].usage).toMatchObject({ reservedUsd: 0, uncertainUsd: .1, spentUsd: 0, voiceAllocatedSeconds: 60 });
    expect(budgetTotals(db.ledger, 'owner', at.toISOString())).toEqual({ userDailyUsd: .1, userMonthlyUsd: .1, globalDailyUsd: .1 });
    expect(budgetTotals(db.ledger, 'owner', expired.toISOString())).toEqual({ userDailyUsd: 0, userMonthlyUsd: 0, globalDailyUsd: 0 });
    expect(await settleVoice(store, reservation, false, expired)).toBe(false);
    expect((await reconcileVoiceReservations(store, { apply: true, now: expired })).reconciled).toBe(0);
    expect(await voiceRows()).toHaveLength(2);
  });
  it('bounds an apply and reports more eligible reservations without closing the remainder', async () => {
    await reserveVoice(store, config, input(), at); await reserveVoice(store, config, input(), at);
    expect(await reconcileVoiceReservations(store, { apply: true, now: expired, maxReservations: 1 })).toMatchObject({ pending: 2, expired: 2, selected: 1, reconciled: 1, moreEligible: true });
    expect((await store.read()).sessions[sessionId].usage).toMatchObject({ reservedUsd: .1, uncertainUsd: .1, voiceAllocatedSeconds: 120 });
    expect(await reconcileVoiceReservations(store, { apply: true, now: expired, maxReservations: 1 })).toMatchObject({ pending: 1, reconciled: 1, moreEligible: false });
  });
  it('fresh admission recovers crashed owner slots while retaining every earlier allocation', async () => {
    const first = await reserveVoice(store, config, input(), at); await reserveVoice(store, config, input(), at);
    await expect(reserveVoice(store, config, input(), new Date(expired.getTime() - 1))).rejects.toMatchObject({ code: 'quota' });
    const next = await reserveVoice(store, config, input(), expired);
    expect(next.key).not.toBe(first.key);
    expect((await store.read()).sessions[sessionId].usage).toMatchObject({ reservedUsd: .1, uncertainUsd: .2, voiceAllocatedSeconds: 180 });
    await expect(reserveVoice(store, config, { ...input(), requestId: first.requestId }, expired)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('recovers the shared 32-slot bound under the same admission transaction', async () => {
    for (let index = 0; index < 16; index++) {
      const ownerId = `global-owner-${index}`, id = await create(store, ownerId);
      await reserveVoice(store, config, input({ ownerId, sessionId: id }), at); await reserveVoice(store, config, input({ ownerId, sessionId: id }), at);
    }
    await expect(reserveVoice(store, config, input(), new Date(expired.getTime() - 1))).rejects.toMatchObject({ code: 'quota' });
    await expect(reserveVoice(store, config, input(), expired)).resolves.toHaveProperty('key');
    expect((await voiceRows()).filter(row => row.voice.state === 'uncertain')).toHaveLength(32);
  });
  it('does not make recovery a refund of lifetime minutes or USD commitments', async () => {
    await reserveVoice(store, config, input(), at); await reconcileVoiceReservations(store, { apply: true, now: expired });
    await expect(reserveVoice(store, { ...config, sessionMinutes: 1 }, input(), expired)).rejects.toMatchObject({ code: 'quota' });
    await expect(reserveVoice(store, { ...config, sessionUsd: .1 }, input(), expired)).rejects.toMatchObject({ code: 'quota' });
    expect((await store.read()).sessions[sessionId].usage.uncertainUsd).toBe(.1);
  });
  it('derives an unambiguous legacy expiry from creation without moving its budget window', async () => {
    const reservation = await reserveVoice(store, config, input(), at);
    await store.transaction(db => { const row = db.ledger.find(entry => entry.operationId === `${reservation.key}:reserved`)! as VoiceLedgerEntry; delete row.voice.expiresAt; delete row.budgetAt; });
    expect((await reconcileVoiceReservations(store, { apply: true, now: expired })).reconciled).toBe(1);
    expect((await voiceRows())[1].budgetAt).toBe(at.toISOString());
    expect(budgetTotals((await store.read()).ledger, 'owner', at.toISOString()).userMonthlyUsd).toBe(.1);
    expect(await settleVoice(store, { ...reservation, expiresAt: undefined }, false, expired)).toBe(false);
  });
  it.each(['duplicate','expiry','budget','counter'] as const)('preserves an ambiguous %s group rather than inventing an outcome', async problem => {
    const reservation = await reserveVoice(store, config, input(), at);
    await store.transaction(db => {
      const row = db.ledger.find(entry => entry.operationId === `${reservation.key}:reserved`)! as VoiceLedgerEntry;
      if (problem === 'duplicate') db.ledger.push({ ...structuredClone(row), id: randomUUID() });
      if (problem === 'expiry') row.voice.expiresAt = at.toISOString();
      if (problem === 'budget') row.budgetAt = expired.toISOString();
      if (problem === 'counter') db.sessions[sessionId].usage.reservedUsd = 0;
    });
    const before = await store.read();
    expect(await reconcileVoiceReservations(store, { apply: true, now: expired })).toMatchObject({ ambiguous: 1, reconciled: 0 });
    expect(await store.read()).toEqual(before);
  });
  it('does not let a terminal posting from another owner/session fence this reservation', async () => {
    const reservation = await reserveVoice(store, config, input(), at);
    await store.transaction(db => { const row = db.ledger.find(entry => entry.operationId === `${reservation.key}:reserved`)! as VoiceLedgerEntry; const foreign: VoiceLedgerEntry = { ...structuredClone(row), id: randomUUID(), ownerId: 'foreign-owner', sessionId: randomUUID(), kind: 'settlement', operationId: `${reservation.key}:settled`, amountUsd: 0, voice: { ...row.voice, state: 'settled' } }; db.ledger.push(foreign); });
    expect(await settleVoice(store, { ...reservation, ownerId: 'foreign-owner' }, false, at)).toBe(false);
    expect((await reconcileVoiceReservations(store, { apply: true, now: expired })).reconciled).toBe(1);
    expect((await voiceRows()).filter(row => row.ownerId === 'owner').map(row => row.voice.state)).toEqual(['reserved', 'uncertain']);
  });
  it('recovers after adapter restart and fences the original callback durably', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-voice-recovery-')); directories.push(directory);
    const adapter = new FilePracticeStore(directory), id = await create(adapter);
    const reservation = await reserveVoice(adapter, config, input({ sessionId: id }), at);
    const restarted = new FilePracticeStore(directory);
    expect((await reconcileVoiceReservations(restarted, { apply: true, now: expired })).reconciled).toBe(1);
    expect(await settleVoice(new FilePracticeStore(directory), reservation, false, expired)).toBe(false);
    expect((await restarted.read()).sessions[id].usage).toMatchObject({ reservedUsd: 0, uncertainUsd: .1, voiceAllocatedSeconds: 60 });
  });
  it('does not recreate erased content while closing an abandoned reservation', async () => {
    const reservation = await reserveVoice(store, config, input(), at);
    await sessions.deleteAccount('owner', { requestId: randomUUID() });
    expect((await reconcileVoiceReservations(store, { apply: true, now: expired })).reconciled).toBe(1);
    expect((await store.read()).sessions).toEqual({});
    expect(await settleVoice(store, reservation, false, expired)).toBe(false);
    expect(budgetTotals((await store.read()).ledger, 'owner', at.toISOString()).userDailyUsd).toBe(.1);
  });
  it('fences a callback at expiry even before maintenance has run', async () => {
    const reservation = await reserveVoice(store, config, input(), at);
    expect(await settleVoice(store, reservation, false, expired)).toBe(false);
    expect((await voiceRows()).map(row => row.voice.state)).toEqual(['reserved','uncertain']);
    expect((await store.read()).sessions[sessionId].usage.spentUsd).toBe(0);
  });
  it('rejects altered callback identity and does not lose a valid original callback', async () => {
    const reservation = await reserveVoice(store, config, input(), at);
    expect(await settleVoice(store, { ...reservation, seconds: 1 }, false, at)).toBe(false);
    expect(await settleVoice(store, { ...reservation, expiresAt: undefined }, false, at)).toBe(false);
    expect(await settleVoice(store, reservation, false, at)).toBe(true);
  });
  it('keeps a missing local store absent on dry-run and rejects unsafe options', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-voice-dry-')); directories.push(directory);
    expect((await reconcileVoiceReservations(new FilePracticeStore(join(directory, 'absent')), { now: expired })).reconciled).toBe(0);
    expect(await readdir(directory)).toEqual([]);
    for (const maxReservations of [0, 501, NaN, 1.1]) await expect(reconcileVoiceReservations(store, { apply: true, maxReservations })).rejects.toMatchObject({ code: 'invalid' });
  });
  it('rolls back the entire apply when durable completion fails', async () => {
    await reserveVoice(store, config, input(), at); const before = await store.read();
    const failing: PracticeStore = { read: () => store.read(), transaction: operation => store.transaction(async db => { await operation(db); throw new Error('synthetic durable failure'); }) };
    await expect(reconcileVoiceReservations(failing, { apply: true, now: expired })).rejects.toThrow('synthetic durable failure');
    expect(await store.read()).toEqual(before);
  });
  it('runs the operator entrypoint as dry-run without creating local storage or invoking providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-voice-cli-')); directories.push(directory);
    const script = new URL('../scripts/reconcile-voice.ts', import.meta.url).pathname;
    const run = (args: string[]) => execFileSync(process.execPath, ['--conditions=react-server','--import','tsx',script,...args], { cwd: new URL('..',import.meta.url), env: { PATH: process.env.PATH, NODE_ENV: 'development', PRACTICE_DATA_PATH: join(directory,'absent','practice.json') }, encoding: 'utf8', stdio: 'pipe' });
    expect(run(['--help'])).toContain('--max-reservations 1..500');
    expect(JSON.parse(run(['--dry-run','--max-reservations','1']))).toMatchObject({ mode: 'dry-run', examined: 0, selected: 0, reconciled: 0 });
    expect(() => run(['--apply','--dry-run'])).toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});

describe('late ephemeral provider responses', () => {
  it.each(['transcribe','speak'] as const)('discards a late %s result after conservative reconciliation', async operation => {
    let clock = at;
    await store.transaction(db => { db.sessions[sessionId].turns.push({ id: 'interviewer-question', role: 'interviewer', text: 'Explain your private implementation.', source: 'authored', evidenceIds: [], createdAt: at.toISOString() }); });
    const fetcher = vi.fn<typeof fetch>(async () => {
      clock = expired;
      await reconcileVoiceReservations(store, { apply: true, now: clock });
      if (operation === 'transcribe') return Response.json({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: 'PRIVATE LATE TRANSCRIPT' }] }] } });
      const audio = Buffer.alloc(417); audio[0] = 255; audio[1] = 251; audio[2] = 144; return new Response(audio);
    });
    const service = new VoiceService(store, config, fetcher, () => clock);
    const audio = Buffer.alloc(44 + 32_000); audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8,4); audio.write('WAVE',8); audio.write('fmt ',12); audio.writeUInt32LE(16,16); audio.writeUInt16LE(1,20); audio.writeUInt16LE(1,22); audio.writeUInt32LE(16_000,24); audio.writeUInt32LE(32_000,28); audio.writeUInt16LE(2,32); audio.writeUInt16LE(16,34); audio.write('data',36); audio.writeUInt32LE(32_000,40);
    const result = operation === 'transcribe' ? service.transcribe('owner', sessionId, randomUUID(), audio, true) : service.speak('owner', sessionId, randomUUID(), 'interviewer-question', true);
    await expect(result).rejects.toMatchObject({ code: 'voice_session_changed' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await voiceRows()).map(row => row.voice.state)).toEqual(['reserved','uncertain']);
    expect(JSON.stringify(await store.read())).not.toContain('PRIVATE LATE TRANSCRIPT');
    expect(JSON.stringify(await voiceRows())).not.toContain('private implementation');
  });
});
