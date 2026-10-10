import { z } from 'zod';
import { canonical, DomainError } from './domain';
import type { AccountClosing, PracticeDatabase } from './types';

const record = z.object({ ownerId: z.string().uuid().refine(value => value === value.toLowerCase()), requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), cleanupId: z.string().uuid(), createdAt: z.string().datetime({ offset: true }) }).strict();
const unavailable = () => new DomainError('unavailable', 'Account closing state could not be verified. Existing data was preserved.');

export function validateAccountClosings(database: PracticeDatabase) {
  if (database.accountClosings === undefined) return;
  if (!database.accountClosings || typeof database.accountClosings !== 'object' || Array.isArray(database.accountClosings)) throw unavailable();
  const cleanup = new Map(database.deletions.map(item => [item.id, item.ownerId]));
  for (const [ownerId, value] of Object.entries(database.accountClosings)) if (!record.safeParse(value).success || ownerId !== value.ownerId || cleanup.get(value.cleanupId) !== ownerId) throw unavailable();
}
export function accountClosing(database: PracticeDatabase, ownerId: string): AccountClosing | undefined {
  // UUID case variants cannot bypass the permanent fence in local adapters.
  ownerId = ownerId.toLowerCase();
  const map = database.accountClosings;
  if (map === undefined) return;
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw unavailable();
  if (!Object.hasOwn(map, ownerId)) return;
  const value = map[ownerId]; if (!record.safeParse(value).success || value.ownerId !== ownerId) throw unavailable();
  return value;
}
export function assertAccountOpen(database: PracticeDatabase, ownerId: string) {
  if (accountClosing(database, ownerId)) throw new DomainError('account_closing', 'This account is permanently closing. Practice cannot be reopened; contact support if account deletion needs attention.');
}
/** Normal writes and retention cannot remove or rewrite a permanent fence. */
export function preserveAccountClosings(before: PracticeDatabase, after: PracticeDatabase) {
  validateAccountClosings(after);
  for (const [ownerId, value] of Object.entries(before.accountClosings ?? {})) {
    if (!after.accountClosings?.[ownerId] || canonical(value) !== canonical(after.accountClosings[ownerId])) throw unavailable();
    if (!after.deletions.some(item => item.id === value.cleanupId && item.ownerId === ownerId)) throw unavailable();
  }
}
