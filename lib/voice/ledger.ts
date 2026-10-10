import { randomUUID } from 'node:crypto';
import { assertActive, assertRequestId, DomainError, ownedSession } from '../interview-practice/domain';
import { budgetTotals } from '../interview-practice/quota';
import type { LedgerEntry, PracticeDatabase } from '../interview-practice/types';
import { HttpError } from '../server/http';
import type { PracticeStore } from '../server/store';
import type { VoiceConfig } from './config';

type VoicePosting = {
  version: 1; key: string; operation: 'transcribe' | 'speak'; requestId: string;
  fingerprint: string; seconds: number; characters: number; reservedUsd: number;
  state: 'reserved' | 'settled' | 'uncertain';
};
export type VoiceLedgerEntry = LedgerEntry & { voice: VoicePosting };
export type VoiceAdmission = {
  ownerId: string; sessionId: string; requestId: string; operation: VoicePosting['operation'];
  fingerprint: string; seconds: number; characters: number; usd: number;
};
export type VoiceReservation = VoiceAdmission & { key: string; at: string };

function postings(database: PracticeDatabase): VoiceLedgerEntry[] {
  return database.ledger.filter((entry): entry is VoiceLedgerEntry => 'voice' in entry && (entry as VoiceLedgerEntry).voice?.version === 1);
}
function usage(entries: VoiceLedgerEntry[]) {
  // Minutes are conservative allocations: failed/short playback does not refund
  // minutes. Costs use the bounded billable input, not a guessed invoice total.
  return entries.filter(entry => entry.voice.state === 'reserved').reduce((sum, entry) => sum + entry.voice.seconds, 0);
}
function append(database: PracticeDatabase, reservation: VoiceReservation, state: VoicePosting['state'], at: string) {
  database.ledger.push({
    id: randomUUID(), ownerId: reservation.ownerId, sessionId: reservation.sessionId,
    operationId: `${reservation.key}:${state}`, kind: state === 'reserved' ? 'reservation' : state === 'settled' ? 'settlement' : 'uncertain',
    amountUsd: state === 'reserved' ? reservation.usd : 0, createdAt: at, budgetAt: reservation.at,
    voice: { version: 1, key: reservation.key, operation: reservation.operation, requestId: reservation.requestId,
      fingerprint: reservation.fingerprint, seconds: reservation.seconds, characters: reservation.characters,
      reservedUsd: reservation.usd, state }
  } as VoiceLedgerEntry);
}

export async function reserveVoice(store: PracticeStore, config: VoiceConfig, input: VoiceAdmission, now = new Date()): Promise<VoiceReservation> {
  assertRequestId(input.requestId);
  if (!Number.isFinite(input.seconds) || input.seconds <= 0 || !Number.isFinite(input.usd) || input.usd < 0 || !Number.isInteger(input.characters) || input.characters < 0) throw new HttpError(400, 'invalid_voice_usage', 'Voice usage was invalid.');
  return store.transaction(database => {
    const session = ownedSession(database.sessions, input.ownerId, input.sessionId); assertActive(session);
    const voice = postings(database); const at = now.toISOString(); const day = at.slice(0, 10);
    if (voice.some(entry => entry.ownerId === input.ownerId && entry.voice.requestId === input.requestId)) throw new DomainError('conflict', 'This audio request was already admitted. Its result is not stored for replay. Continue in text or make a new recording.');
    const dailyVoice = voice.filter(entry => entry.createdAt.slice(0, 10) === day);
    const retainedSeconds = session.usage.voiceAllocatedSeconds;
    if (retainedSeconds !== undefined && (!Number.isFinite(retainedSeconds) || retainedSeconds < 0)) throw new DomainError('unavailable', 'Voice usage counters need operator review. Continue in text.');
    const sessionSeconds = retainedSeconds ?? usage(voice.filter(entry => entry.sessionId === input.sessionId));
    const userSeconds = usage(dailyVoice.filter(entry => entry.ownerId === input.ownerId));
    const globalSeconds = usage(dailyVoice);
    const sessionUsd = session.usage.reservedUsd + session.usage.spentUsd + session.usage.uncertainUsd;
    const { userDailyUsd: userUsd, userMonthlyUsd, globalDailyUsd: globalUsd } = budgetTotals(database.ledger, input.ownerId, at);
    const terminal = new Set(voice.filter(entry => entry.voice.state !== 'reserved').map(entry => entry.voice.key));
    const pending = voice.filter(entry => entry.voice.state === 'reserved' && !terminal.has(entry.voice.key));
    if (pending.length >= 32 || pending.filter(entry => entry.ownerId === input.ownerId).length >= 2) throw new DomainError('quota', 'A voice request is already in progress. Continue in text and try again later.');
    if (sessionSeconds + input.seconds > config.sessionMinutes * 60 || userSeconds + input.seconds > config.userDailyMinutes * 60 || globalSeconds + input.seconds > config.globalDailyMinutes * 60 ||
        sessionUsd + input.usd > config.sessionUsd + 1e-9 || userUsd + input.usd > config.userDailyUsd + 1e-9 || userMonthlyUsd + input.usd > config.userMonthlyUsd + 1e-9 || globalUsd + input.usd > config.globalDailyUsd + 1e-9) throw new DomainError('quota', 'The voice budget cannot cover this request. Continue with text; your saved work is available.');
    const reservation: VoiceReservation = { ...input, key: `voice:${randomUUID()}`, at };
    session.usage.reservedUsd += input.usd;
    session.usage.voiceAllocatedSeconds = sessionSeconds + input.seconds;
    append(database, reservation, 'reserved', at);
    return reservation;
  });
}

export async function settleVoice(store: PracticeStore, reservation: VoiceReservation, uncertain: boolean, now = new Date()): Promise<boolean> {
  return store.transaction(database => {
    const voice = postings(database);
    if (!voice.some(entry => entry.voice.key === reservation.key && entry.voice.state === 'reserved')) return false;
    if (voice.some(entry => entry.voice.key === reservation.key && entry.voice.state !== 'reserved')) return false;
    const session = database.sessions[reservation.sessionId];
    // Deletion may race with the provider. Keep only the content-free posting;
    // never recreate a deleted session or return audio/transcript after deletion.
    if (session?.ownerId === reservation.ownerId) {
      session.usage.reservedUsd = Math.max(0, session.usage.reservedUsd - reservation.usd);
      if (uncertain) session.usage.uncertainUsd += reservation.usd; else session.usage.spentUsd += reservation.usd;
    }
    append(database, reservation, uncertain ? 'uncertain' : 'settled', now.toISOString());
    return Boolean(session?.ownerId === reservation.ownerId && session.lifecycle === 'active');
  });
}
