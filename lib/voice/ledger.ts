import { randomUUID } from 'node:crypto';
import { assertActive, assertRequestId, DomainError, ownedSession } from '../interview-practice/domain';
import { budgetTotals } from '../interview-practice/quota';
import type { LedgerEntry, PracticeDatabase, Session } from '../interview-practice/types';
import { HttpError } from '../server/http';
import type { PracticeStore } from '../server/store';
import type { VoiceConfig } from './config';

type VoicePosting = {
  version: 1; key: string; operation: 'transcribe' | 'speak'; requestId: string;
  fingerprint: string; seconds: number; characters: number; reservedUsd: number;
  state: 'reserved' | 'settled' | 'uncertain';
  expiresAt?: string;
};
export type VoiceLedgerEntry = LedgerEntry & { voice: VoicePosting };
export type VoiceAdmission = {
  ownerId: string; sessionId: string; requestId: string; operation: VoicePosting['operation'];
  fingerprint: string; seconds: number; characters: number; usd: number;
};
export type VoiceReservation = VoiceAdmission & { key: string; at: string; expiresAt?: string };
export const VOICE_RECONCILIATION_POLICY = { version: 'voice-reservation-v1', leaseMs: 120_000, defaultBatch: 100, maximumBatch: 500, maximumScannedRows: 100_000, admissionBatch: 32 } as const;
export type VoiceReconciliationOptions = { apply?: boolean; maxReservations?: number; now?: Date };
export type VoiceReconciliationResult = { policyVersion: string; mode: 'dry-run' | 'apply'; checkedAt: string; batchLimit: number; examined: number; pending: number; expired: number; selected: number; reconciled: number; ambiguous: number; moreEligible: boolean };

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
      reservedUsd: reservation.usd, state, ...(reservation.expiresAt ? { expiresAt: reservation.expiresAt } : {}) }
  } as VoiceLedgerEntry);
}

const groupKey = (entry: Pick<VoiceLedgerEntry, 'ownerId' | 'sessionId' | 'voice'>) => JSON.stringify([entry.ownerId, entry.sessionId, entry.voice.key]);
function instant(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const milliseconds = Date.parse(value); return Number.isFinite(milliseconds) ? milliseconds : undefined;
}
function reservationFrom(entry: VoiceLedgerEntry): VoiceReservation | undefined {
  const voice = entry.voice, at = instant(entry.createdAt), budgetAt = entry.budgetAt === undefined ? at : instant(entry.budgetAt);
  if (entry.kind !== 'reservation' || voice.state !== 'reserved' || typeof entry.id !== 'string' || !entry.id || typeof entry.ownerId !== 'string' || !entry.ownerId || typeof entry.sessionId !== 'string' || !entry.sessionId || typeof voice.key !== 'string' || !/^voice:[a-zA-Z0-9_-]{1,70}$/.test(voice.key)
    || entry.operationId !== `${voice.key}:reserved` || !['transcribe', 'speak'].includes(voice.operation) || !/^[a-zA-Z0-9_-]{8,128}$/.test(voice.requestId) || !/^[a-f0-9]{64}$/.test(voice.fingerprint)
    || !Number.isFinite(voice.seconds) || voice.seconds <= 0 || voice.seconds > 120 || !Number.isSafeInteger(voice.characters) || voice.characters < 0 || voice.characters > 1500 || !Number.isFinite(voice.reservedUsd) || voice.reservedUsd < 0 || voice.reservedUsd > 100 || entry.amountUsd !== voice.reservedUsd || at === undefined || budgetAt !== at) return undefined;
  const expiresAt = at + VOICE_RECONCILIATION_POLICY.leaseMs;
  if (voice.expiresAt !== undefined && instant(voice.expiresAt) !== expiresAt) return undefined;
  return { ownerId: entry.ownerId, sessionId: entry.sessionId, requestId: voice.requestId, operation: voice.operation, fingerprint: voice.fingerprint, seconds: voice.seconds, characters: voice.characters, usd: voice.reservedUsd, key: voice.key, at: new Date(at).toISOString(), expiresAt: new Date(expiresAt).toISOString() };
}
function compatibleTerminal(entry: VoiceLedgerEntry, reservation: VoiceReservation): boolean {
  const voice = entry.voice;
  return entry.ownerId === reservation.ownerId && entry.sessionId === reservation.sessionId && entry.operationId === `${reservation.key}:${voice.state}` && entry.amountUsd === 0
    && (entry.kind === 'settlement' && voice.state === 'settled' || entry.kind === 'uncertain' && voice.state === 'uncertain')
    && voice.requestId === reservation.requestId && voice.operation === reservation.operation && voice.fingerprint === reservation.fingerprint && voice.seconds === reservation.seconds && voice.characters === reservation.characters && voice.reservedUsd === reservation.usd
    && instant(entry.createdAt) !== undefined && (entry.budgetAt === undefined || instant(entry.budgetAt) === instant(reservation.at)) && (voice.expiresAt === undefined || instant(voice.expiresAt) === instant(reservation.expiresAt));
}
function pendingVoice(entries: VoiceLedgerEntry[]) {
  const terminal = new Map<string, VoiceLedgerEntry[]>();
  for (const entry of entries) if (entry.voice.state !== 'reserved') { const key = groupKey(entry), group = terminal.get(key) ?? []; group.push(entry); terminal.set(key, group); }
  return entries.filter(entry => {
    if (entry.voice.state !== 'reserved') return false;
    const reservation = reservationFrom(entry), finished = terminal.get(groupKey(entry));
    return !reservation || finished?.length !== 1 || !compatibleTerminal(finished[0], reservation);
  });
}
function closeReservation(database: PracticeDatabase, reservation: VoiceReservation, uncertain: boolean, at: string) {
  const session = database.sessions[reservation.sessionId];
  if (session?.ownerId === reservation.ownerId) {
    session.usage.reservedUsd = Math.max(0, session.usage.reservedUsd - reservation.usd);
    if (uncertain) session.usage.uncertainUsd += reservation.usd; else session.usage.spentUsd += reservation.usd;
  }
  append(database, reservation, uncertain ? 'uncertain' : 'settled', at);
}
function reconciliation(database: PracticeDatabase, options: VoiceReconciliationOptions): VoiceReconciliationResult {
  const now = options.now?.getTime() ?? Date.now(), batchLimit = options.maxReservations ?? VOICE_RECONCILIATION_POLICY.defaultBatch;
  if (!Number.isFinite(now) || !Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > VOICE_RECONCILIATION_POLICY.maximumBatch) throw new DomainError('invalid', 'Choose a supported voice reconciliation batch.');
  if (database.ledger.length > VOICE_RECONCILIATION_POLICY.maximumScannedRows) throw new DomainError('unavailable', 'Voice reconciliation scan capacity was reached. Existing usage was preserved.');
  const result: VoiceReconciliationResult = { policyVersion: VOICE_RECONCILIATION_POLICY.version, mode: options.apply ? 'apply' : 'dry-run', checkedAt: new Date(now).toISOString(), batchLimit, examined: database.ledger.length, pending: 0, expired: 0, selected: 0, reconciled: 0, ambiguous: 0, moreEligible: false };
  const voiceEntries = postings(database);
  result.ambiguous = database.ledger.filter(entry => 'voice' in entry).length - voiceEntries.length;
  const groups = new Map<string, VoiceLedgerEntry[]>(), ids = new Map<string, number>();
  for (const entry of database.ledger) ids.set(entry.id, (ids.get(entry.id) ?? 0) + 1);
  for (const entry of voiceEntries) { const key = groupKey(entry), group = groups.get(key) ?? []; group.push(entry); groups.set(key, group); }
  const pendingAmounts = new Map<string, number>();
  for (const entry of pendingVoice(voiceEntries)) pendingAmounts.set(JSON.stringify([entry.ownerId, entry.sessionId]), (pendingAmounts.get(JSON.stringify([entry.ownerId, entry.sessionId])) ?? 0) + entry.amountUsd);
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const reserved = group.filter(entry => entry.voice.state === 'reserved'), terminal = group.filter(entry => entry.voice.state !== 'reserved');
    if (!reserved.length) { result.ambiguous++; continue; }
    const reservation = reserved.length === 1 ? reservationFrom(reserved[0]) : undefined;
    if (!reservation || group.some(entry => ids.get(entry.id) !== 1) || terminal.length > 1 || terminal.some(entry => !compatibleTerminal(entry, reservation))) { result.ambiguous++; continue; }
    if (terminal.length) continue;
    result.pending++;
    const session = database.sessions[reservation.sessionId], pendingAmount = pendingAmounts.get(JSON.stringify([reservation.ownerId, reservation.sessionId]))!;
    if (!Number.isFinite(pendingAmount) || pendingAmount < 0 || session && (session.ownerId !== reservation.ownerId || !Number.isFinite(session.usage.reservedUsd) || !Number.isFinite(session.usage.uncertainUsd) || session.usage.reservedUsd < pendingAmount - 1e-9 || session.usage.uncertainUsd < 0)) { result.ambiguous++; continue; }
    if (instant(reservation.expiresAt)! > now) continue;
    result.expired++;
    if (result.selected >= batchLimit) { result.moreEligible = true; continue; }
    result.selected++;
    if (options.apply) {
      closeReservation(database, reservation, true, result.checkedAt); result.reconciled++;
      pendingAmounts.set(JSON.stringify([reservation.ownerId, reservation.sessionId]), pendingAmount - reservation.usd);
    }
  }
  return result;
}

/** No provider calls or refunds. Apply replans under the existing store lock. */
export async function reconcileVoiceReservations(store: PracticeStore, options: VoiceReconciliationOptions = {}): Promise<VoiceReconciliationResult> {
  return options.apply === true ? store.transaction(database => reconciliation(database, options)) : reconciliation(await store.read(), options);
}

/** Setup preference never replaces explicit per-operation processing consent. */
export function assertVoiceSession(session: Session) {
  assertActive(session);
  if (session.configuration.voice !== true || session.configuration.practiceConditions?.participation === 'written-only') throw new HttpError(403, 'voice_not_selected', 'This attempt uses text. Select optional voice when starting a new attempt.');
  if (session.stageId !== 'debrief' || !session.codeFrozenSnapshotId || session.frozenEvidence) throw new HttpError(409, 'voice_debrief_required', 'Voice answers are available during the debrief after Finish coding. Continue in text while working.');
}

export async function reserveVoice(store: PracticeStore, config: VoiceConfig, input: VoiceAdmission, now = new Date()): Promise<VoiceReservation> {
  assertRequestId(input.requestId);
  if (!Number.isFinite(input.seconds) || input.seconds <= 0 || !Number.isFinite(input.usd) || input.usd < 0 || !Number.isInteger(input.characters) || input.characters < 0) throw new HttpError(400, 'invalid_voice_usage', 'Voice usage was invalid.');
  return store.transaction(database => {
    const session = ownedSession(database.sessions, input.ownerId, input.sessionId); assertVoiceSession(session);
    const at = now.toISOString(); const day = at.slice(0, 10);
    if (postings(database).some(entry => entry.ownerId === input.ownerId && entry.voice.requestId === input.requestId)) throw new DomainError('conflict', 'This audio request was already admitted. Its result is not stored for replay. Continue in text or make a new recording.');
    reconciliation(database, { apply: true, now, maxReservations: VOICE_RECONCILIATION_POLICY.admissionBatch });
    const voice = postings(database);
    const dailyVoice = voice.filter(entry => entry.createdAt.slice(0, 10) === day);
    const retainedSeconds = session.usage.voiceAllocatedSeconds;
    if (retainedSeconds !== undefined && (!Number.isFinite(retainedSeconds) || retainedSeconds < 0)) throw new DomainError('unavailable', 'Voice usage counters need operator review. Continue in text.');
    const sessionSeconds = retainedSeconds ?? usage(voice.filter(entry => entry.sessionId === input.sessionId));
    const userSeconds = usage(dailyVoice.filter(entry => entry.ownerId === input.ownerId));
    const globalSeconds = usage(dailyVoice);
    const sessionUsd = session.usage.reservedUsd + session.usage.spentUsd + session.usage.uncertainUsd;
    const { userDailyUsd: userUsd, userMonthlyUsd, globalDailyUsd: globalUsd } = budgetTotals(database.ledger, input.ownerId, at);
    const pending = pendingVoice(voice);
    if (pending.length >= 32 || pending.filter(entry => entry.ownerId === input.ownerId).length >= 2) throw new DomainError('quota', 'A voice request is already in progress. Continue in text and try again later.');
    if (sessionSeconds + input.seconds > config.sessionMinutes * 60 || userSeconds + input.seconds > config.userDailyMinutes * 60 || globalSeconds + input.seconds > config.globalDailyMinutes * 60 ||
        sessionUsd + input.usd > config.sessionUsd + 1e-9 || userUsd + input.usd > config.userDailyUsd + 1e-9 || userMonthlyUsd + input.usd > config.userMonthlyUsd + 1e-9 || globalUsd + input.usd > config.globalDailyUsd + 1e-9) throw new DomainError('quota', 'The voice budget cannot cover this request. Continue with text; your saved work is available.');
    const reservation: VoiceReservation = { ...input, key: `voice:${randomUUID()}`, at, expiresAt: new Date(now.getTime() + VOICE_RECONCILIATION_POLICY.leaseMs).toISOString() };
    session.usage.reservedUsd += input.usd;
    session.usage.voiceAllocatedSeconds = sessionSeconds + input.seconds;
    append(database, reservation, 'reserved', at);
    return reservation;
  });
}

export async function settleVoice(store: PracticeStore, reservation: VoiceReservation, uncertain: boolean, now = new Date()): Promise<boolean> {
  return store.transaction(database => {
    const voice = postings(database);
    const group = voice.filter(entry => entry.ownerId === reservation.ownerId && entry.sessionId === reservation.sessionId && entry.voice.key === reservation.key);
    if (group.length !== 1) return false;
    const admitted = reservationFrom(group[0]);
    if (!admitted || database.ledger.filter(entry => entry.id === group[0].id).length !== 1 || ['ownerId','sessionId','requestId','operation','fingerprint','seconds','characters','usd','key','at'].some(key => admitted[key as keyof VoiceReservation] !== reservation[key as keyof VoiceReservation]) || ((group[0].voice.expiresAt !== undefined || reservation.expiresAt !== undefined) && reservation.expiresAt !== admitted.expiresAt)) return false;
    if (!Number.isFinite(now.getTime()) || now.getTime() < instant(admitted.at)!) return false;
    const expired = now.getTime() >= instant(admitted.expiresAt)!;
    const session = database.sessions[reservation.sessionId];
    // Deletion may race with the provider. Keep only the content-free posting;
    // never recreate a deleted session or return audio/transcript after deletion.
    closeReservation(database, admitted, uncertain || expired, now.toISOString());
    return Boolean(!expired && session?.ownerId === reservation.ownerId && session.lifecycle === 'active' && session.configuration.voice === true && session.configuration.practiceConditions?.participation !== 'written-only' && session.stageId === 'debrief' && session.codeFrozenSnapshotId && !session.frozenEvidence);
  });
}
