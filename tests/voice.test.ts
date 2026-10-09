import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getScenario } from '../lib/content/scenarios';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { voiceConfig, type VoiceConfig } from '../lib/voice/config';
import { mp3Duration, wavDuration } from '../lib/voice/audio';
import { reserveVoice, settleVoice } from '../lib/voice/ledger';
import { voiceDebriefFixture } from './voice-fixtures';
import { boundedBytes, VoiceService } from '../lib/voice/provider';

const config: VoiceConfig = { apiKey: 'fixture-not-a-key', sttUsdPerMinute: 0.0043, ttsUsdPerThousandChars: 0.03, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 600, sessionUsd: 1, userDailyUsd: 5, userMonthlyUsd: 50, globalDailyUsd: 50 };
const at = new Date('2026-10-09T12:00:00Z');
function wav(seconds = 1) {
  const buffer = Buffer.alloc(44 + seconds * 32_000);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24); buffer.writeUInt32LE(32_000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(buffer.length - 44, 40); return buffer;
}
function mp3() { const bytes = Buffer.alloc(417 * 2); for (const offset of [0, 417]) { bytes[offset] = 255; bytes[offset + 1] = 251; bytes[offset + 2] = 144; } return bytes; }
const recognized = () => Response.json({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: 'I checked the rounding boundary.' }] }] } });
let store: MemoryPracticeStore, sessions: SessionService, sessionId: string;
const fetcher = vi.fn<typeof fetch>();
beforeEach(async () => {
  store = new MemoryPracticeStore(); sessions = new SessionService(store, getScenario);
  sessionId = (await sessions.createSession('owner-a', { scenarioId: 'monetary-validation', voice: true, requestId: randomUUID() })).session.id;
  await voiceDebriefFixture(store,sessionId);
  fetcher.mockReset();
});
const voice = () => new VoiceService(store, config, fetcher, () => at);
const admission = (overrides = {}) => ({ ownerId: 'owner-a', sessionId, requestId: randomUUID(), operation: 'transcribe' as const, fingerprint: 'a'.repeat(64), seconds: 60, characters: 0, usd: 0.3, ...overrides });

describe('voice availability and bounded formats', () => {
  it('fails closed without qualification, explicit rates, limits, or production database', () => {
    const env = { FEATURE_VOICE: 'true', VOICE_QUALIFIED: 'true', DEEPGRAM_API_KEY: 'test-only', VOICE_STT_USD_PER_MINUTE: '.0043', VOICE_TTS_USD_PER_1K_CHARS: '.03', VOICE_MAX_SESSION_MINUTES: '20', VOICE_MAX_USER_DAILY_MINUTES: '60', VOICE_MAX_GLOBAL_DAILY_MINUTES: '600', MAX_SESSION_USD: '1', MAX_DAILY_USER_USD: '5', MAX_MONTHLY_USER_USD: '50', VOICE_MAX_GLOBAL_DAILY_USD: '50' };
    expect(voiceConfig(env)).toMatchObject({ sttUsdPerMinute: .0043 });
    expect(voiceConfig({ ...env, VOICE_QUALIFIED: 'false' })).toBeNull();
    expect(voiceConfig({ ...env, MAX_MONTHLY_USER_USD: '' })).toBeNull();
    expect(voiceConfig({ ...env, MAX_MONTHLY_USER_USD: 'NaN' })).toBeNull();
    expect(voiceConfig({ ...env, VOICE_STT_USD_PER_MINUTE: '.001' })).toBeNull();
    expect(voiceConfig({ ...env, VOICE_MAX_GLOBAL_DAILY_MINUTES: 'Infinity' })).toBeNull();
    expect(voiceConfig({ ...env, NODE_ENV: 'production' })).toBeNull();
    expect(voiceConfig({ ...env, NODE_ENV: 'production', DATABASE_URL: 'postgres://configured' })).not.toBeNull();
  });
  it('derives duration from canonical PCM bytes and rejects forged headers, trailing data and oversize recordings', () => {
    expect(wavDuration(wav(60))).toBe(60);
    const forged = wav(); forged.writeUInt32LE(1, 28); expect(() => wavDuration(forged)).toThrow();
    expect(() => wavDuration(Buffer.concat([wav(), Buffer.from('extra')]))).toThrow();
    expect(() => wavDuration(wav(61))).toThrow();
    expect(() => wavDuration(Buffer.from('webm'))).toThrow();
  });
  it('parses full MP3 frames and rejects truncated, free-format and arbitrary payloads', () => {
    expect(mp3Duration(mp3())).toBeCloseTo(2304 / 44100);
    expect(() => mp3Duration(mp3().subarray(0, 420))).toThrow();
    const malformed = mp3(); malformed[2] = 0; expect(() => mp3Duration(malformed)).toThrow();
    expect(() => mp3Duration(Buffer.from('not audio'))).toThrow();
  });
  it('bounds streamed bytes even when content-length is absent or dishonest', async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10)); controller.enqueue(new Uint8Array(10)); controller.close(); } });
    await expect(boundedBytes(new Response(stream), 12)).rejects.toMatchObject({ status: 413 });
    await expect(boundedBytes(new Response('oversize', { headers: { 'Content-Length': '999' } }), 12)).rejects.toMatchObject({ status: 413 });
  });
});

describe('speech boundary and ephemeral results', () => {
  it.each([false,undefined])('requires a persisted voice opt-in, treating historical absent preference as text: %s', async selected => {
    await store.transaction(db => { db.sessions[sessionId].configuration.voice = selected; });
    const before = await store.read();
    await expect(voice().checkOwner('owner-a',sessionId)).rejects.toMatchObject({ code: 'voice_not_selected',status: 403 });
    await expect(voice().transcribe('owner-a',sessionId,randomUUID(),wav(),true)).rejects.toMatchObject({ code: 'voice_not_selected' });
    await expect(reserveVoice(store,config,admission(),at)).rejects.toMatchObject({ code: 'voice_not_selected' });
    expect(fetcher).not.toHaveBeenCalled(); expect(await store.read()).toEqual(before);
  });
  it('rejects selected voice before the debrief without spending or changing saved work', async () => {
    await store.transaction(db => { db.sessions[sessionId].stageId = 'inspect'; db.sessions[sessionId].codeFrozenSnapshotId = null; });
    const before = await store.read();
    await expect(voice().transcribe('owner-a',sessionId,randomUUID(),wav(),true)).rejects.toMatchObject({ code: 'voice_debrief_required',status: 409 });
    await expect(reserveVoice(store,config,admission(),at)).rejects.toMatchObject({ code: 'voice_debrief_required' });
    expect(fetcher).not.toHaveBeenCalled(); expect(await store.read()).toEqual(before);
  });
  it('checks opt-in again atomically after a successful preliminary owner check', async () => {
    await voice().checkOwner('owner-a',sessionId);
    await store.transaction(db => { db.sessions[sessionId].configuration.voice = false; });
    const before = await store.read();
    await expect(reserveVoice(store,config,admission(),at)).rejects.toMatchObject({ code: 'voice_not_selected' });
    expect(await store.read()).toEqual(before); expect(fetcher).not.toHaveBeenCalled();
  });
  it('requires consent, ownership and an active attempt before any provider call', async () => {
    await expect(voice().transcribe('owner-a', sessionId, randomUUID(), wav(), false)).rejects.toMatchObject({ code: 'voice_consent_required' });
    await expect(voice().transcribe('owner-b', sessionId, randomUUID(), wav(), true)).rejects.toMatchObject({ code: 'not_found' });
    await store.transaction(db => { db.sessions[sessionId].lifecycle = 'paused'; });
    await expect(voice().transcribe('owner-a', sessionId, randomUUID(), wav(), true)).rejects.toMatchObject({ code: 'conflict' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks shared monthly AI commitments before calling a speech provider even when daily budget is available', async () => {
    const priorDay = '2026-10-08T12:00:00.000Z';
    await store.transaction(db => {
      db.ledger.push({ id: randomUUID(), ownerId: 'owner-a', sessionId, operationId: 'prior-ai:1:reserve', kind: 'reservation', amountUsd: .08, createdAt: priorDay, budgetAt: priorDay });
    });
    const limited = new VoiceService(store, { ...config, userMonthlyUsd: .08 }, fetcher, () => at);
    await expect(limited.transcribe('owner-a', sessionId, randomUUID(), wav(), true)).rejects.toMatchObject({ code: 'quota' });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await store.read()).ledger.filter(entry => entry.operationId.startsWith('voice:'))).toHaveLength(0);
  });
  it('sends binary WAV with opt-out and returns a draft without committing or persisting audio or transcript', async () => {
    fetcher.mockResolvedValue(recognized());
    expect(await voice().transcribe('owner-a', sessionId, randomUUID(), wav(), true)).toBe('I checked the rounding boundary.');
    const [url, options] = fetcher.mock.calls[0]; expect(url).toContain('mip_opt_out=true'); expect(url).toContain('model=nova-3');
    expect((options!.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
    expect(options!.redirect).toBe('error'); expect(options!.body).toBeInstanceOf(Blob);
    const database = await store.read(); expect(database.sessions[sessionId].turns).toHaveLength(0);
    expect(JSON.stringify(database)).not.toContain('I checked the rounding boundary.');
    expect(database.ledger.filter(entry => entry.kind === 'reservation')).toHaveLength(1);
    expect(database.sessions[sessionId].usage.reservedUsd).toBe(0);
    expect(database.sessions[sessionId].usage.spentUsd).toBeGreaterThan(0);
  });
  it('only speaks an existing interviewer turn and refuses arbitrary text and learner turns', async () => {
    await store.transaction(db => { db.sessions[sessionId].turns.push(
      { id: 'question-id', role: 'interviewer', text: 'How did you verify rounding?', source: 'authored', evidenceIds: [], createdAt: at.toISOString() },
      { id: 'learner-id', role: 'learner', text: 'Learner secret', source: 'typed', evidenceIds: [], createdAt: at.toISOString() }
    ); });
    await expect(voice().speak('owner-a', sessionId, randomUUID(), 'question-id', true, 'Read arbitrary text')).rejects.toMatchObject({ code: 'voice_text_mismatch' });
    await expect(voice().speak('owner-a', sessionId, randomUUID(), 'learner-id', true)).rejects.toMatchObject({ status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response(mp3()));
    expect(await voice().speak('owner-a', sessionId, randomUUID(), 'question-id', true)).toEqual(new Uint8Array(mp3()));
    const [url, options] = fetcher.mock.calls[0]; expect(url).toContain('mip_opt_out=true'); expect(url).toContain('encoding=mp3');
    expect(JSON.parse(options!.body as string)).toEqual({ text: 'How did you verify rounding?' });
    expect(JSON.stringify((await store.read()).ledger)).not.toContain('How did you verify');
  });
  it('holds ambiguous charges and never retries a duplicate request key', async () => {
    fetcher.mockRejectedValue(new Error('fixture transport error containing secret'));
    const key = randomUUID();
    await expect(voice().transcribe('owner-a', sessionId, key, wav(), true)).rejects.toMatchObject({ code: 'voice_provider_unavailable' });
    await expect(voice().transcribe('owner-a', sessionId, key, wav(), true)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const database = await store.read(); expect(database.sessions[sessionId].usage.uncertainUsd).toBeGreaterThan(0);
    expect(database.sessions[sessionId].usage.reservedUsd).toBe(0);
    expect(JSON.stringify(database)).not.toContain('fixture transport error');
  });
  it('discards a provider result if deletion happens while it is in flight', async () => {
    fetcher.mockImplementation(async () => { await sessions.deleteSession('owner-a', sessionId, { requestId: randomUUID() }); return recognized(); });
    await expect(voice().transcribe('owner-a', sessionId, randomUUID(), wav(), true)).rejects.toMatchObject({ code: 'voice_session_changed' });
    expect((await store.read()).sessions[sessionId]).toBeUndefined();
    expect(JSON.stringify(await store.read())).not.toContain('rounding boundary');
  });
  it('discards a provider result when voice selection no longer permits it while retaining actual accounting', async () => {
    fetcher.mockImplementation(async () => { await store.transaction(db => { db.sessions[sessionId].configuration.voice = false; }); return recognized(); });
    await expect(voice().transcribe('owner-a',sessionId,randomUUID(),wav(),true)).rejects.toMatchObject({ code: 'voice_session_changed' });
    const saved = await store.read();
    expect(saved.sessions[sessionId].usage.spentUsd).toBeGreaterThan(0);
    expect(saved.sessions[sessionId].usage.reservedUsd).toBe(0);
    expect(JSON.stringify(saved)).not.toContain('rounding boundary');
  });
});

describe('atomic speech admission', () => {
  it('admits an idempotency key at most once under concurrency', async () => {
    const input = admission();
    const results = await Promise.allSettled([reserveVoice(store, config, input, at), reserveVoice(store, config, input, at)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.read()).ledger.filter(entry => entry.kind === 'reservation')).toHaveLength(1);
  });
  it.each(['sessionMinutes', 'userDailyMinutes', 'globalDailyMinutes', 'sessionUsd', 'userDailyUsd', 'userMonthlyUsd', 'globalDailyUsd'] as const)('enforces %s across simultaneous requests', async scope => {
    const secondOwner = scope.startsWith('global') ? 'owner-b' : 'owner-a';
    const secondId = scope.startsWith('session') ? sessionId : (await sessions.createSession(secondOwner, { scenarioId: 'monetary-validation', voice: true, requestId: randomUUID() })).session.id;
    if (secondId !== sessionId) await voiceDebriefFixture(store,secondId);
    const limited = { ...config, [scope]: scope.endsWith('Minutes') ? 1 : .3 };
    const results = await Promise.allSettled([
      reserveVoice(store, limited, admission(), at),
      reserveVoice(store, limited, admission({ ownerId: secondOwner, sessionId: secondId }), at)
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  });
  it('counts AI commitments toward voice spend and retains conservative minutes after uncertainty', async () => {
    await store.transaction(db => { db.sessions[sessionId].usage.uncertainUsd = .8; });
    await expect(reserveVoice(store, config, admission(), at)).rejects.toMatchObject({ code: 'quota' });
    await store.transaction(db => { db.sessions[sessionId].usage.uncertainUsd = 0; });
    const reservation = await reserveVoice(store, { ...config, sessionMinutes: 1 }, admission(), at);
    await settleVoice(store, reservation, true, at); await settleVoice(store, reservation, true, at);
    await expect(reserveVoice(store, { ...config, sessionMinutes: 1 }, admission(), at)).rejects.toMatchObject({ code: 'quota' });
    expect((await store.read()).ledger.filter(entry => entry.kind === 'uncertain')).toHaveLength(1);
  });
  it('keeps lifetime session minutes after expired ledger rows are removed', async () => {
    await reserveVoice(store, { ...config, sessionMinutes: 1 }, admission(), at);
    await store.transaction(db => { db.ledger = db.ledger.filter(entry => !entry.operationId.startsWith('voice:')); });
    await expect(reserveVoice(store, { ...config, sessionMinutes: 1 }, admission(), new Date('2027-01-01T12:00:00Z'))).rejects.toMatchObject({ code: 'quota' });
    expect((await store.read()).sessions[sessionId].usage.voiceAllocatedSeconds).toBe(60);
  });
});
