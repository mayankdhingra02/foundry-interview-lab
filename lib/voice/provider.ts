import 'server-only';
import { createHash } from 'node:crypto';
import { assertActive, ownedSession } from '../interview-practice/domain';
import { HttpError } from '../server/http';
import type { PracticeStore } from '../server/store';
import { MAX_SPEAK_CHARACTERS, MAX_SPEAK_SECONDS, type VoiceConfig } from './config';
import { mp3Duration, wavDuration } from './audio';
import { reserveVoice, settleVoice } from './ledger';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export async function boundedBytes(response: Response, limit: number, timeoutMs = 25_000): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length') || 0) > limit) { await response.body?.cancel(); throw new HttpError(413, 'voice_body_too_large', 'Audio exceeded the supported size. Continue in text.'); }
  const reader = response.body?.getReader(); if (!reader) throw new HttpError(400, 'voice_body_missing', 'Audio was not available.');
  const chunks: Uint8Array[] = []; let size = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new HttpError(408, 'voice_body_timeout', 'Audio upload took too long. Continue in text.')); void reader.cancel().catch(() => {}); }, timeoutMs); });
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'voice_body_too_large', 'Audio exceeded the supported size. Continue in text.'); }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally { clearTimeout(timer); }
}

export class VoiceService {
  constructor(private store: PracticeStore, private config: VoiceConfig, private fetcher: typeof fetch = fetch, private now: () => Date = () => new Date()) {}
  async checkOwner(ownerId: string, sessionId: string) {
    const session = ownedSession((await this.store.read()).sessions, ownerId, sessionId); assertActive(session); return session;
  }
  private async call(path: string, body: BodyInit, contentType: string, signal?: AbortSignal) {
    return this.fetcher(`https://api.deepgram.com${path}`, {
      method: 'POST', redirect: 'error', headers: { Authorization: `Token ${this.config.apiKey}`, 'Content-Type': contentType }, body,
      signal: AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])])
    });
  }
  async transcribe(ownerId: string, sessionId: string, requestId: string, audio: Uint8Array, consent: boolean, signal?: AbortSignal): Promise<string> {
    if (!consent) throw new HttpError(400, 'voice_consent_required', 'Allow speech processing before recording an answer.');
    const seconds = wavDuration(audio);
    const reservation = await reserveVoice(this.store, this.config, {
      ownerId, sessionId, requestId, operation: 'transcribe', fingerprint: hash(`transcribe:${requestId}:${seconds}`), seconds, characters: 0,
      usd: Math.ceil(seconds / 60 * this.config.sttUsdPerMinute * 1e8) / 1e8
    }, this.now());
    let completed = false;
    try {
      const response = await this.call('/v1/listen?model=nova-3&language=en&smart_format=true&mip_opt_out=true', new Blob([audio as BlobPart], { type: 'audio/wav' }), 'audio/wav', signal);
      if (!response.ok) throw new Error('Speech provider rejected request');
      const bytes = await boundedBytes(response, 64_000);
      const result = JSON.parse(new TextDecoder().decode(bytes));
      const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
      const duration = result?.metadata?.duration;
      if (typeof text !== 'string' || text.length > 12_000 || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > seconds + 0.25) throw new Error('Invalid transcription response');
      const accessible = await settleVoice(this.store, reservation, false, this.now()); completed = true;
      if (!accessible) throw new HttpError(409, 'voice_session_changed', 'This attempt is no longer active. The audio result was discarded.');
      if (!text.trim()) throw new HttpError(422, 'speech_not_recognized', 'No speech was recognized. Try again or type your answer.');
      return text.trim();
    } catch (error) {
      if (!completed) await settleVoice(this.store, reservation, true, this.now());
      if (error instanceof HttpError && completed) throw error;
      throw new HttpError(503, 'voice_provider_unavailable', 'Transcription could not finish. Continue in text. This request will not be retried automatically.');
    }
  }
  async speak(ownerId: string, sessionId: string, requestId: string, turnId: string, consent: boolean, claimedText?: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (!consent) throw new HttpError(400, 'voice_consent_required', 'Allow speech processing before playing a question.');
    const session = await this.checkOwner(ownerId, sessionId);
    const turn = session.turns.find(item => item.id === turnId && item.role === 'interviewer');
    if (!turn) throw new HttpError(404, 'interviewer_turn_not_found', 'Select a recorded interviewer question.');
    if (claimedText !== undefined && claimedText !== turn.text) throw new HttpError(400, 'voice_text_mismatch', 'Question audio must match the recorded interviewer question.');
    // UTF-16 length conservatively counts supplementary characters twice.
    const characters = turn.text.length;
    if (!characters || characters > MAX_SPEAK_CHARACTERS) throw new HttpError(400, 'question_too_long', 'This question is too long for audio playback. Read the visible question.');
    const reservation = await reserveVoice(this.store, this.config, {
      ownerId, sessionId, requestId, operation: 'speak', fingerprint: hash(`speak:${requestId}`), seconds: MAX_SPEAK_SECONDS, characters,
      usd: Math.ceil(characters / 1000 * this.config.ttsUsdPerThousandChars * 1e8) / 1e8
    }, this.now());
    let completed = false;
    try {
      const response = await this.call('/v1/speak?model=aura-2-thalia-en&encoding=mp3&bit_rate=48000&mip_opt_out=true', JSON.stringify({ text: turn.text }), 'application/json', signal);
      if (!response.ok) throw new Error('Speech provider rejected request');
      const audio = await boundedBytes(response, 1_000_000);
      if (mp3Duration(audio) > MAX_SPEAK_SECONDS) throw new Error('Audio duration exceeded limit');
      const accessible = await settleVoice(this.store, reservation, false, this.now()); completed = true;
      if (!accessible) throw new HttpError(409, 'voice_session_changed', 'This attempt is no longer active. The audio result was discarded.');
      return audio;
    } catch (error) {
      if (!completed) await settleVoice(this.store, reservation, true, this.now());
      if (error instanceof HttpError && completed) throw error;
      throw new HttpError(503, 'voice_provider_unavailable', 'Question audio could not finish. Read the visible question. This request will not be retried automatically.');
    }
  }
}
