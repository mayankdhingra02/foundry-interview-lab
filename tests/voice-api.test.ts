import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getScenario } from '../lib/content/scenarios';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { handleVoiceRequest } from '../lib/voice/api';

const mocked = vi.hoisted(() => ({ getService: vi.fn() }));
vi.mock('../lib/server/application', () => ({ getService: mocked.getService }));
const origin = 'http://127.0.0.1:3134';
let store: MemoryPracticeStore, id: string;
const fetcher = vi.fn<typeof fetch>();
function recording() {
  const bytes = Buffer.alloc(32_044); bytes.write('RIFF'); bytes.writeUInt32LE(32_036, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32_000, 40);
  return new Blob([bytes], { type: 'audio/wav' });
}
function form() { const result = new FormData(); result.append('audio', recording(), 'answer.wav'); result.append('consent', 'true'); result.append('requestId', randomUUID()); return result; }
const upload = (body: FormData) => new Request(`${origin}/api/interview-practice/sessions/${id}/voice/transcribe`, { method: 'POST', headers: { origin }, body });
const speech = (body: object) => new Request(`${origin}/api/interview-practice/sessions/${id}/voice/speak`, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
beforeEach(async () => {
  for (const [key, value] of Object.entries({ APP_URL: origin, FEATURE_VOICE: 'true', VOICE_QUALIFIED: 'true', DEEPGRAM_API_KEY: 'fixture-never-sent', VOICE_STT_USD_PER_MINUTE: '.0043', VOICE_TTS_USD_PER_1K_CHARS: '.03', VOICE_MAX_SESSION_MINUTES: '20', VOICE_MAX_USER_DAILY_MINUTES: '60', VOICE_MAX_GLOBAL_DAILY_MINUTES: '600', MAX_SESSION_USD: '1', MAX_DAILY_USER_USD: '5', MAX_MONTHLY_USER_USD: '50', VOICE_MAX_GLOBAL_DAILY_USD: '50' })) vi.stubEnv(key, value);
  store = new MemoryPracticeStore(); const service = new SessionService(store, getScenario);
  id = (await service.createSession('owner-a', { scenarioId: 'monetary-validation', requestId: randomUUID() })).session.id;
  mocked.getService.mockResolvedValue(service); fetcher.mockReset(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('authenticated voice dispatch helper', () => {
  it('fails closed when qualification is absent and checks origin and ownership before upload parsing', async () => {
    vi.stubEnv('VOICE_QUALIFIED', 'false');
    await expect(handleVoiceRequest(upload(form()), 'owner-a', id, 'transcribe')).rejects.toMatchObject({ status: 503 });
    vi.stubEnv('VOICE_QUALIFIED', 'true');
    const wrongOrigin = upload(form()); wrongOrigin.headers.set('origin', 'https://other.invalid');
    await expect(handleVoiceRequest(wrongOrigin, 'owner-a', id, 'transcribe')).rejects.toMatchObject({ status: 403 });
    await expect(handleVoiceRequest(upload(new FormData()), 'owner-b', id, 'transcribe')).rejects.toMatchObject({ status: 404 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects missing consent, duplicate files and unrecognized multipart fields before provider admission', async () => {
    const noConsent = form(); noConsent.set('consent', 'false');
    await expect(handleVoiceRequest(upload(noConsent), 'owner-a', id, 'transcribe')).rejects.toMatchObject({ code: 'voice_consent_required' });
    const duplicate = form(); duplicate.append('audio', recording(), 'second.wav');
    await expect(handleVoiceRequest(upload(duplicate), 'owner-a', id, 'transcribe')).rejects.toMatchObject({ code: 'invalid_audio_form' });
    const forgedDuration = form(); forgedDuration.append('duration', '.001');
    await expect(handleVoiceRequest(upload(forgedDuration), 'owner-a', id, 'transcribe')).rejects.toMatchObject({ code: 'invalid_audio_form' });
    expect(fetcher).not.toHaveBeenCalled(); expect((await store.read()).ledger.filter(entry => entry.kind === 'reservation')).toHaveLength(0);
  });
  it('returns only the uncommitted transcript under private no-store headers', async () => {
    fetcher.mockResolvedValue(Response.json({ metadata: { duration: 1 }, results: { channels: [{ alternatives: [{ transcript: 'Fixture transcript for contract test.' }] }] } }));
    const response = await handleVoiceRequest(upload(form()), 'owner-a', id, 'transcribe');
    expect(response.headers.get('cache-control')).toContain('no-store'); expect(await response.json()).toEqual({ text: 'Fixture transcript for contract test.', source: 'transcribed' });
    expect((await store.read()).sessions[id].turns).toHaveLength(0);
    expect(JSON.stringify(await store.read())).not.toContain('Fixture transcript');
  });
  it('does not accept arbitrary client speech text or a missing recorded turn ID', async () => {
    await store.transaction(db => { db.sessions[id].turns.push({ id: 'question', role: 'interviewer', text: 'Recorded question', source: 'authored', evidenceIds: [], createdAt: new Date().toISOString() }); });
    await expect(handleVoiceRequest(speech({ consent: true, requestId: randomUUID(), text: 'Arbitrary client speech' }), 'owner-a', id, 'speak')).rejects.toMatchObject({ code: 'invalid_voice_request' });
    await expect(handleVoiceRequest(speech({ consent: true, requestId: randomUUID(), turnId: 'question', text: 'Arbitrary client speech' }), 'owner-a', id, 'speak')).rejects.toMatchObject({ code: 'voice_text_mismatch' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
