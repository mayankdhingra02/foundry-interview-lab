import { z } from 'zod';
import { DomainError } from './domain';
import type { DeletionRecord, PracticeDatabase } from './types';

export const PRIVATE_CLEANUP_POLICY = Object.freeze({ version: 'private-file-cleanup-v1', bucket: 'interview-lab-private', maxAttempts: 1008, maxFailures: 8, leaseMs: 300_000, defaultRecords: 1, maxRecords: 5, defaultObjects: 10, maxObjects: 20, maxInventory: 1000, maxInventoryBytes: 200_000, maxKeyBytes: 2048 });
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const keyPattern = new RegExp(`^owners/(${uuid})/sessions/(${uuid})/artifacts/(${uuid})$`);
const timestamp = z.string().datetime({ offset: true });
export const privateCleanupAttemptSchema = z.object({
  version: z.literal(1), targetDigest: z.string().regex(/^[a-f0-9]{64}$/), attempt: z.number().int().min(1).max(PRIVATE_CLEANUP_POLICY.maxAttempts), failureCount: z.number().int().min(0).max(PRIVATE_CLEANUP_POLICY.maxFailures),
  claimToken: z.string().uuid().nullable(), leaseExpiresAt: timestamp.nullable(), nextAttemptAt: timestamp.nullable(),
  lastError: z.enum(['object_still_present', 'absence_unverified', 'interrupted']).nullable(),
}).strict().refine(value => (value.claimToken === null) === (value.leaseExpiresAt === null), 'Incomplete cleanup lease.')
  .refine(value => value.claimToken === null || (value.nextAttemptAt === null && value.lastError === null), 'A claim cannot retain an old retry state.');

/** Fixed bucket-relative namespace; keys are never URLs, bucket names or authorization. */
export function ownsPrivateObjectKey(ownerId: string, key: string): boolean {
  return typeof key === 'string' && keyPattern.exec(key)?.[1] === ownerId && ownerId === ownerId.toLowerCase();
}
export function ownsPrivateInventoryKey(record: DeletionRecord, key: string, accountCleanupId: string): boolean {
  return ownsPrivateObjectKey(record.ownerId, key) && (record.id === accountCleanupId || keyPattern.exec(key)?.[2] === record.sessionId);
}
export function boundedPrivateInventory(keys: unknown): keys is string[] {
  return Array.isArray(keys) && keys.length <= PRIVATE_CLEANUP_POLICY.maxInventory && new Set(keys).size === keys.length
    && keys.every(key => typeof key === 'string' && key.length > 0 && Buffer.byteLength(key) <= PRIVATE_CLEANUP_POLICY.maxKeyBytes)
    && keys.reduce((size: number, key: string) => size + Buffer.byteLength(key), 0) <= PRIVATE_CLEANUP_POLICY.maxInventoryBytes;
}
/** Legacy rows may omit cleanup metadata; new metadata always fails closed. */
export function validateDeletionCleanup(record: DeletionRecord): void {
  if (record.cleanup === undefined) return;
  const parsed = privateCleanupAttemptSchema.safeParse(record.cleanup);
  if (!parsed.success || !boundedPrivateInventory(record.objectKeys) || !['pending', 'completed'].includes(record.state)
    || (record.state === 'completed' && (record.objectKeys.length > 0 || !timestamp.safeParse(record.completedAt).success || parsed.data.claimToken !== null || parsed.data.nextAttemptAt !== null || parsed.data.lastError !== null))
    || (record.state === 'pending' && (record.objectKeys.length === 0 || record.completedAt !== undefined))) {
    throw new DomainError('unavailable', 'Private cleanup metadata could not be verified. Existing inventory was preserved.');
  }
}
export function validateStoredPrivateCleanup(database: PracticeDatabase): void {
  for (const record of database.deletions) validateDeletionCleanup(record);
}
