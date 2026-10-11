import { randomUUID } from 'node:crypto';
import { canonical } from '../interview-practice/domain';
import { boundedPrivateInventory, ownsPrivateInventoryKey, PRIVATE_CLEANUP_POLICY, validateDeletionCleanup } from '../interview-practice/private-cleanup';
import { validateAccountClosings } from '../interview-practice/account-closing';
import type { DeletionRecord, PracticeDatabase, PrivateCleanupError } from '../interview-practice/types';
import type { PracticeStore } from './store';
import type { PrivateObjectStore } from './private-object-store';

export type PrivateCleanupSummary = {
  event: 'private_file_cleanup.finished'; policy: string; mode: 'dry_run' | 'apply'; status: 'complete' | 'bucket_unverified' | 'interrupted';
  pendingRecords: number; eligibleRecords: number; unanchoredRecords: number; unrecognizedObjects: number; malformedRecords: number;
  leasedRecords: number; deferredRecords: number; exhaustedRecords: number; targetMismatchRecords: number;
  attemptedRecords: number; verifiedAbsentObjects: number; completedRecords: number; failedRecords: number; staleResults: number;
};
type Options = { apply?: boolean; maxRecords?: number; maxObjects?: number; now?: () => Date; signal?: AbortSignal };
type Claim = { id: string; ownerId: string; anchorId: string; token: string; leaseExpiresAt: number; keys: string[]; inventory: string[] };
function effectiveFailures(item: DeletionRecord, now: number): number {
  return (item.cleanup?.failureCount ?? 0) + (item.cleanup?.claimToken && item.cleanup.leaseExpiresAt && Date.parse(item.cleanup.leaseExpiresAt) <= now ? 1 : 0);
}
function scan(database: PracticeDatabase, now: number, target: string | undefined, counts?: PrivateCleanupSummary): DeletionRecord[] {
  if (database.deletions.length > 100_000) throw new Error('cleanup_capacity_exceeded');
  validateAccountClosings(database);
  const candidates: DeletionRecord[] = [];
  for (const item of database.deletions) {
    if (item.state !== 'pending') continue;
    if (counts) counts.pendingRecords++;
    const fence = database.accountClosings?.[item.ownerId];
    if (!fence || fence.ownerId !== item.ownerId) { if (counts) counts.unanchoredRecords++; continue; }
    try { validateDeletionCleanup(item); } catch { if (counts) counts.malformedRecords++; continue; }
    if (!boundedPrivateInventory(item.objectKeys) || !Number.isFinite(Date.parse(item.createdAt))) { if (counts) counts.malformedRecords++; continue; }
    const valid = item.objectKeys.filter(key => ownsPrivateInventoryKey(item, key, fence.cleanupId));
    if (counts) counts.unrecognizedObjects += item.objectKeys.length - valid.length;
    if (!valid.length) continue;
    const attempt = item.cleanup;
    if (target && attempt && attempt.targetDigest !== target) { if (counts) counts.targetMismatchRecords++; continue; }
    if (attempt?.leaseExpiresAt && Date.parse(attempt.leaseExpiresAt) > now) { if (counts) counts.leasedRecords++; continue; }
    if (attempt?.nextAttemptAt && Date.parse(attempt.nextAttemptAt) > now) { if (counts) counts.deferredRecords++; continue; }
    if ((attempt?.attempt ?? 0) >= PRIVATE_CLEANUP_POLICY.maxAttempts || effectiveFailures(item, now) >= PRIVATE_CLEANUP_POLICY.maxFailures) { if (counts) counts.exhaustedRecords++; continue; }
    candidates.push(item); if (counts) counts.eligibleRecords++;
  }
  return candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function current(database: PracticeDatabase, claim: Claim, targetDigest: string, now: number): DeletionRecord | undefined {
  const item = database.deletions.find(record => record.id === claim.id && record.ownerId === claim.ownerId);
  const fence = database.accountClosings?.[claim.ownerId];
  if (!item || item.state !== 'pending' || fence?.ownerId !== claim.ownerId || fence.cleanupId !== claim.anchorId || item.cleanup?.claimToken !== claim.token
    || item.cleanup.targetDigest !== targetDigest || !item.cleanup.leaseExpiresAt || Date.parse(item.cleanup.leaseExpiresAt) <= now
    || canonical(item.objectKeys) !== canonical(claim.inventory)) return;
  return item;
}
/** Operator-only manual batch. Storage requests never run under a database transaction. */
export async function runPrivateFileCleanup(store: PracticeStore, objects?: PrivateObjectStore, options: Options = {}): Promise<PrivateCleanupSummary> {
  const apply = options.apply ?? false, maxRecords = options.maxRecords ?? PRIVATE_CLEANUP_POLICY.defaultRecords, maxObjects = options.maxObjects ?? PRIVATE_CLEANUP_POLICY.defaultObjects;
  if (typeof apply !== 'boolean' || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > PRIVATE_CLEANUP_POLICY.maxRecords || !Number.isInteger(maxObjects) || maxObjects < 1 || maxObjects > PRIVATE_CLEANUP_POLICY.maxObjects
    || (apply && (!objects || !/^[a-f0-9]{64}$/.test(objects.targetDigest)))) throw new Error('cleanup_options_invalid');
  const now = () => { const value = (options.now?.() ?? new Date()).getTime(); if (!Number.isFinite(value)) throw new Error('cleanup_clock_invalid'); return value; };
  const summary: PrivateCleanupSummary = { event: 'private_file_cleanup.finished', policy: PRIVATE_CLEANUP_POLICY.version, mode: apply ? 'apply' : 'dry_run', status: 'complete', pendingRecords: 0, eligibleRecords: 0, unanchoredRecords: 0, unrecognizedObjects: 0, malformedRecords: 0, leasedRecords: 0, deferredRecords: 0, exhaustedRecords: 0, targetMismatchRecords: 0, attemptedRecords: 0, verifiedAbsentObjects: 0, completedRecords: 0, failedRecords: 0, staleResults: 0 };
  scan(await store.read(), now(), objects?.targetDigest, summary);
  if (!apply || summary.eligibleRecords === 0) return summary;
  if (options.signal?.aborted) { summary.status = 'interrupted'; return summary; }
  let verified = false; try { verified = await objects!.verifyPrivateBucket(options.signal); } catch { /* No private diagnostics escape. */ }
  if (!verified) { summary.status = options.signal?.aborted ? 'interrupted' : 'bucket_unverified'; return summary; }
  let processed = 0; const visited = new Set<string>();
  while (summary.attemptedRecords < maxRecords && processed < maxObjects && !options.signal?.aborted) {
    const claim = await store.transaction(database => {
      const item = scan(database, now(), objects!.targetDigest).find(record => !visited.has(record.id)); if (!item) return;
      const timestamp = now(), token = randomUUID();
      item.cleanup = { version: 1, targetDigest: objects!.targetDigest, attempt: (item.cleanup?.attempt ?? 0) + 1, failureCount: effectiveFailures(item, timestamp), claimToken: token, leaseExpiresAt: new Date(timestamp + PRIVATE_CLEANUP_POLICY.leaseMs).toISOString(), nextAttemptAt: null, lastError: null };
      const anchorId = database.accountClosings![item.ownerId].cleanupId;
      return { id: item.id, ownerId: item.ownerId, anchorId, token, leaseExpiresAt: timestamp + PRIVATE_CLEANUP_POLICY.leaseMs, keys: item.objectKeys.filter(key => ownsPrivateInventoryKey(item, key, anchorId)).slice(0, maxObjects - processed), inventory: [...item.objectKeys] } satisfies Claim;
    });
    if (!claim) break;
    visited.add(claim.id); summary.attemptedRecords++; let failure: PrivateCleanupError | null = null, stale = false;
    for (const key of claim.keys) {
      if (options.signal?.aborted) { failure = 'interrupted'; break; }
      if (now() >= claim.leaseExpiresAt) { summary.staleResults++; stale = true; break; }
      processed++;
      try { await objects!.remove(claim.ownerId, key, options.signal); } catch { /* Even a lost delete response can be reconciled by exact absence. */ }
      let absence: 'absent' | 'present' | 'unknown' = 'unknown';
      try { absence = await objects!.absence(claim.ownerId, key, options.signal); } catch { /* Preserve the inventory. */ }
      if (options.signal?.aborted) { failure = 'interrupted'; break; }
      if (absence !== 'absent') { failure = absence === 'present' ? 'object_still_present' : 'absence_unverified'; continue; }
      const accepted = await store.transaction(database => {
        const item = current(database, claim, objects!.targetDigest, now()); if (!item) return false;
        item.objectKeys = item.objectKeys.filter(value => value !== key); claim.inventory = [...item.objectKeys];
        if (!item.objectKeys.length) {
          item.state = 'completed'; item.completedAt = new Date(now()).toISOString();
          item.cleanup = { ...item.cleanup!, claimToken: null, leaseExpiresAt: null, nextAttemptAt: null, lastError: null };
        }
        return true;
      });
      if (!accepted) { summary.staleResults++; stale = true; break; }
      summary.verifiedAbsentObjects++;
      if (!claim.inventory.length) { summary.completedRecords++; break; }
    }
    if (!stale && claim.inventory.length) {
      const accepted = await store.transaction(database => {
        const item = current(database, claim, objects!.targetDigest, now()); if (!item) return false;
        const failureCount = item.cleanup!.failureCount + (failure ? 1 : 0);
        item.cleanup = { ...item.cleanup!, failureCount, claimToken: null, leaseExpiresAt: null, nextAttemptAt: failure ? new Date(now() + Math.min(300_000, 5000 * 2 ** (failureCount - 1))).toISOString() : null, lastError: failure };
        return true;
      });
      if (!accepted) summary.staleResults++; else if (failure) summary.failedRecords++;
    }
  }
  if (options.signal?.aborted) summary.status = 'interrupted';
  return summary;
}
