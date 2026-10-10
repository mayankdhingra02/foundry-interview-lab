import 'server-only';
import { z } from 'zod';
import { ledgerBudgetGroupKey } from '../interview-practice/quota';
import type { LedgerEntry, PracticeDatabase, RequestRecord } from '../interview-practice/types';
import type { PracticeStore } from './store';

const DAY = 86_400_000;
export const RETENTION_POLICY = { version: 'operational-retention-v1', ledgerDays: 62, metadataDays: 30, defaultBatchRows: 100, maximumBatchRows: 1000, maximumScannedRows: 100_000 } as const;
type Table = 'requests' | 'ledger' | 'deletions';
type Reason = 'not_expired' | 'active_obligation' | 'ambiguous_reference' | 'unsettled_or_uncertain' | 'ambiguous_ledger' | 'current_budget_reference' | 'pending_cleanup' | 'referenced_metadata' | 'legacy_voice_counter';
type Counts = Record<Table, number>;
export type RetentionResult = {
  policyVersion: typeof RETENTION_POLICY.version; mode: 'dry-run' | 'apply'; checkedAt: string;
  cutoffs: { ledger: string; metadata: string }; batchLimit: number;
  examined: Counts; eligible: Counts; selected: Counts; removed: Counts;
  retained: Record<Reason, number>; moreEligible: boolean;
};
export type RetentionOptions = { apply?: boolean; maxRows?: number; now?: Date };
export class RetentionError extends Error {
  constructor(public readonly code: 'invalid_options' | 'scan_limit') {
    super(code === 'scan_limit' ? 'Retention scan exceeds its safety limit.' : 'Retention options are invalid.');
    this.name = 'RetentionError';
  }
}
const counts = (): Counts => ({ requests: 0, ledger: 0, deletions: 0 });
const reasons = (): Record<Reason, number> => ({ not_expired: 0, active_obligation: 0, ambiguous_reference: 0, unsettled_or_uncertain: 0, ambiguous_ledger: 0, current_budget_reference: 0, pending_cleanup: 0, referenced_metadata: 0, legacy_voice_counter: 0 });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const instant = z.string().datetime({ offset: true });
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !instant.safeParse(value).success) return undefined;
  const at = Date.parse(value); return Number.isFinite(at) ? at : undefined;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function requestSession(record: RequestRecord): { id?: string; ambiguous: boolean } {
  const result = object(record.result), nested = object(result?.session);
  const candidates = [record.sessionId, nested?.id, result?.sessionId].filter(value => value !== undefined && value !== null);
  if (candidates.some(value => typeof value !== 'string' || !value) || new Set(candidates).size > 1) return { ambiguous: true };
  return { id: candidates[0] as string | undefined, ambiguous: false };
}
function deletionComplete(record: PracticeDatabase['deletions'][number], now: number) {
  const completed = timestamp(record.completedAt);
  return record.state === 'completed' && Array.isArray(record.objectKeys) && record.objectKeys.length === 0 && completed !== undefined && completed <= now;
}
function expired(value: unknown, cutoff: number) { const at = timestamp(value); return at !== undefined && at <= cutoff; }
function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }

function plan(database: PracticeDatabase, options: RetentionOptions): { result: RetentionResult; requestKeys: Set<string>; ledgerIds: Set<string>; deletionIds: Set<string> } {
  const now = options.now?.getTime() ?? Date.now(), limit = options.maxRows ?? RETENTION_POLICY.defaultBatchRows;
  if (!Number.isFinite(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > RETENTION_POLICY.maximumBatchRows) throw new RetentionError('invalid_options');
  const requests = Object.entries(database.requests), sessions = Object.values(database.sessions), review = database.reviews;
  const scanned = requests.length + database.ledger.length + database.deletions.length + sessions.length + sessions.reduce((sum, session) => sum + session.jobs.length, 0)
    + Object.values(review?.cases ?? {}).length + Object.values(review?.drafts ?? {}).length + Object.values(review?.decisions ?? {}).length + Object.values(review?.publications ?? {}).length + (review?.audits.length ?? 0);
  if (scanned > RETENTION_POLICY.maximumScannedRows) throw new RetentionError('scan_limit');
  const ledgerCutoff = now - RETENTION_POLICY.ledgerDays * DAY, metadataCutoff = now - RETENTION_POLICY.metadataDays * DAY;
  const result: RetentionResult = {
    policyVersion: RETENTION_POLICY.version, mode: options.apply === true ? 'apply' : 'dry-run', checkedAt: new Date(now).toISOString(),
    cutoffs: { ledger: new Date(ledgerCutoff).toISOString(), metadata: new Date(metadataCutoff).toISOString() }, batchLimit: limit,
    examined: { requests: requests.length, ledger: database.ledger.length, deletions: database.deletions.length }, eligible: counts(), selected: counts(), removed: counts(), retained: reasons(), moreEligible: false,
  };
  const requestKeys = new Set<string>(), ledgerIds = new Set<string>(), deletionIds = new Set<string>();
  const protectedSessions = new Set<string>(), protectedOwners = new Set<string>(), completedDeletions = new Set<string>();
  for (const session of sessions) {
    if (session.lifecycle !== 'completed' || session.jobs.some(job => job.state === 'queued' || job.state === 'running')) {
      protectedSessions.add(session.id); protectedOwners.add(session.ownerId);
    }
  }
  for (const item of Object.values(review?.cases ?? {})) if (item.status !== 'resolved') { protectedSessions.add(item.sessionId); protectedOwners.add(item.ownerId); }
  for (const item of database.deletions) {
    if (deletionComplete(item, now) && validIdentity(item.ownerId) && validIdentity(item.sessionId)) completedDeletions.add(JSON.stringify([item.ownerId, item.sessionId]));
    else { protectedSessions.add(item.sessionId); protectedOwners.add(item.ownerId); }
  }
  let selectedRows = 0;
  const select = (table: Table, ids: string[], target: Set<string>) => {
    result.eligible[table] += ids.length;
    if (selectedRows + ids.length > limit) { result.moreEligible = true; return; }
    ids.forEach(id => target.add(id)); result.selected[table] += ids.length; selectedRows += ids.length;
  };

  // Request caches may contain redundant session copies. Only a trusted terminal
  // or verified deleted-session link permits expiry of those copies.
  for (const [key, record] of requests.sort((a, b) => compare(a[1].createdAt, b[1].createdAt) || compare(a[0], b[0]))) {
    let reason: Reason | undefined;
    const link = requestSession(record);
    if (!expired(record.createdAt, metadataCutoff)) reason = timestamp(record.createdAt) === undefined ? 'ambiguous_reference' : 'not_expired';
    else if (key !== `${record.ownerId}:${record.requestId}` || !validIdentity(record.ownerId) || !validIdentity(record.requestId) || link.ambiguous) reason = 'ambiguous_reference';
    else if (link.id) {
      const session = database.sessions[link.id];
      if (protectedSessions.has(link.id)) reason = 'active_obligation';
      else if (session) {
        if (session.ownerId !== record.ownerId || session.lifecycle !== 'completed' || !session.reports.length) reason = 'ambiguous_reference';
      } else if (!completedDeletions.has(JSON.stringify([record.ownerId, link.id]))) reason = 'ambiguous_reference';
    } else {
      const value = object(record.result);
      const deletionAcknowledgment = value?.deleted === true && Object.keys(value).length === 1;
      reason = !deletionAcknowledgment ? 'ambiguous_reference' : protectedOwners.has(record.ownerId) ? 'active_obligation' : undefined;
    }
    if (reason) result.retained[reason]++; else select('requests', [key], requestKeys);
  }

  const groups = new Map<string, LedgerEntry[]>();
  const malformed: LedgerEntry[] = [];
  const ledgerIdCounts = new Map<string, number>();
  database.ledger.forEach(entry => ledgerIdCounts.set(entry.id, (ledgerIdCounts.get(entry.id) ?? 0) + 1));
  for (const entry of database.ledger) {
    if (!validIdentity(entry.id) || ledgerIdCounts.get(entry.id) !== 1 || !validIdentity(entry.ownerId) || !validIdentity(entry.sessionId) || !validIdentity(entry.operationId) || !Number.isFinite(entry.amountUsd) || timestamp(entry.createdAt) === undefined || (entry.budgetAt !== undefined && timestamp(entry.budgetAt) === undefined)) { malformed.push(entry); continue; }
    const key = ledgerBudgetGroupKey(entry);
    if (entry.kind !== 'admission' && !key) { malformed.push(entry); continue; }
    const identity = key ?? JSON.stringify(['admission', entry.ownerId, entry.sessionId, entry.operationId]);
    const group = groups.get(identity) ?? []; group.push(entry); groups.set(identity, group);
  }
  result.retained.ambiguous_ledger += malformed.length;
  for (const [, group] of [...groups].sort(([a], [b]) => compare(a, b))) {
    let reason: Reason | undefined;
    const admissions = group.every(entry => entry.kind === 'admission');
    const reservations = group.filter(entry => entry.kind === 'reservation'), settlements = group.filter(entry => entry.kind === 'settlement');
    if (!group.every(entry => expired(entry.createdAt, ledgerCutoff))) reason = 'not_expired';
    else if (group.some(entry => entry.budgetAt !== undefined && !expired(entry.budgetAt, ledgerCutoff))) reason = 'current_budget_reference';
    else if (group.some(entry => protectedSessions.has(entry.sessionId))) reason = 'active_obligation';
    else if (new Set(group.map(entry => entry.id)).size !== group.length || admissions && (group.length !== 1 || group[0].amountUsd !== 0)) reason = 'ambiguous_ledger';
    else if (!admissions && (group.some(entry => entry.kind === 'uncertain') || !settlements.length)) reason = 'unsettled_or_uncertain';
    else if (!admissions && (group.length !== 2 || reservations.length !== 1 || settlements.length !== 1 || reservations[0].amountUsd < 0)) reason = 'ambiguous_ledger';
    else if (!admissions && reservations[0].budgetAt !== undefined && timestamp(reservations[0].budgetAt) !== timestamp(reservations[0].createdAt)) reason = 'ambiguous_ledger';
    else if (!admissions && group.some(entry => entry.budgetAt !== undefined && timestamp(entry.budgetAt) !== timestamp(reservations[0].budgetAt ?? reservations[0].createdAt))) reason = 'ambiguous_ledger';
    else if (group.some(entry => 'voice' in entry && database.sessions[entry.sessionId] && database.sessions[entry.sessionId].usage.voiceAllocatedSeconds === undefined)) reason = 'legacy_voice_counter';
    if (reason) result.retained[reason] += group.length; else select('ledger', group.map(entry => entry.id), ledgerIds);
  }

  // Keep a tombstone while an unpruned cached response needs it to prove that a
  // missing session was deleted, rather than silently orphaned by legacy data.
  const remainingReferences = new Set(requests.filter(([key]) => !requestKeys.has(key)).map(([, record]) => {
    const link = requestSession(record); return link.id ? JSON.stringify([record.ownerId, link.id]) : '';
  }));
  const deletionIdCounts = new Map<string, number>();
  database.deletions.forEach(entry => deletionIdCounts.set(entry.id, (deletionIdCounts.get(entry.id) ?? 0) + 1));
  for (const record of [...database.deletions].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))) {
    let reason: Reason | undefined;
    if (!validIdentity(record.id) || deletionIdCounts.get(record.id) !== 1 || !validIdentity(record.ownerId) || !validIdentity(record.sessionId) || timestamp(record.createdAt) === undefined) reason = 'ambiguous_reference';
    else if (!deletionComplete(record, now)) reason = 'pending_cleanup';
    else if (!expired(record.createdAt, metadataCutoff) || !expired(record.completedAt, metadataCutoff)) reason = 'not_expired';
    else if (database.sessions[record.sessionId] || protectedSessions.has(record.sessionId)) reason = 'active_obligation';
    else if (remainingReferences.has(JSON.stringify([record.ownerId, record.sessionId]))) reason = 'referenced_metadata';
    if (reason) result.retained[reason]++; else select('deletions', [record.id], deletionIds);
  }
  return { result, requestKeys, ledgerIds, deletionIds };
}

/** Dry-run never invokes a write transaction. Apply replans under the store lock. */
export async function runRetention(store: PracticeStore, options: RetentionOptions = {}): Promise<RetentionResult> {
  if (options.apply !== true) return plan(await store.read(), options).result;
  return store.transaction(database => {
    const planned = plan(database, options);
    for (const key of planned.requestKeys) delete database.requests[key];
    database.ledger = database.ledger.filter(entry => !planned.ledgerIds.has(entry.id));
    database.deletions = database.deletions.filter(entry => !planned.deletionIds.has(entry.id));
    planned.result.removed = { ...planned.result.selected };
    return planned.result;
  });
}
