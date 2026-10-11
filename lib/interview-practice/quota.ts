import { DomainError } from './domain';
import type { LedgerEntry } from './types';

type PostingGroup = { reservations: LedgerEntry[]; settlements: LedgerEntry[]; uncertain: boolean };
export type BudgetTotals = { userDailyUsd: number; userMonthlyUsd: number; globalDailyUsd: number };
const invalid = () => new DomainError('unavailable', 'Budget usage records need operator review. Your acknowledged work is preserved.');
function utc(value: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid();
  const instant = new Date(value); if (!Number.isFinite(instant.getTime())) throw invalid(); return instant.toISOString();
}
/** Content-free grouping identity shared with safe whole-group retention. */
export function ledgerBudgetGroupKey(entry: LedgerEntry): string | undefined {
  if (typeof entry.ownerId !== 'string' || typeof entry.sessionId !== 'string' || typeof entry.operationId !== 'string') return undefined;
  const suffix = entry.kind === 'reservation' ? /:(?:reserve|reserved)$/ : entry.kind === 'settlement' ? /:(?:settle|settled)$/ : entry.kind === 'uncertain' ? /:uncertain$/ : undefined;
  if (!suffix?.test(entry.operationId)) return undefined;
  // Full operation prefix retains the retry reservation sequence. JSON encoding
  // cannot collide when owner/session IDs happen to contain separators.
  return JSON.stringify([entry.ownerId, entry.sessionId, entry.operationId.replace(suffix, '')]);
}
function reservedAt(entry: LedgerEntry) {
  const at = utc(entry.createdAt);
  // The reservation's admission clock is authoritative. Metadata cannot move a
  // reservation into a more convenient quota window.
  if (entry.budgetAt !== undefined && utc(entry.budgetAt) !== at) throw invalid();
  return at;
}

/** New terminal postings inherit their exact original reservation's budget window. */
export function reservationBudgetAt(ledger: readonly LedgerEntry[], identity: Pick<LedgerEntry, 'ownerId' | 'sessionId' | 'operationId'>): string | undefined {
  const matches = ledger.filter(entry => entry.kind === 'reservation' && entry.ownerId === identity.ownerId && entry.sessionId === identity.sessionId && entry.operationId === identity.operationId);
  return matches.length === 1 ? reservedAt(matches[0]) : undefined;
}

/**
 * USD attribution follows reservation windows, rather than late posting clocks.
 * Legacy rows are associated by exact owner/session/full operation prefix.
 * Orphan/ambiguous credits cannot reduce any window; positive charges remain held.
 */
export function budgetTotals(ledger: readonly LedgerEntry[], ownerId: string, now: string): BudgetTotals {
  const current = utc(now), day = current.slice(0,10), month = current.slice(0,7), groups = new Map<string, PostingGroup>();
  for (const entry of ledger) {
    if (!Number.isFinite(entry.amountUsd) || entry.kind !== 'settlement' && entry.amountUsd < 0 || typeof entry.ownerId !== 'string' || !entry.ownerId || typeof entry.sessionId !== 'string' || !entry.sessionId || typeof entry.operationId !== 'string' || !['admission','reservation','settlement','uncertain'].includes(entry.kind)) throw invalid();
    utc(entry.createdAt);
    const key = ledgerBudgetGroupKey(entry); if (!key) continue;
    const group = groups.get(key) ?? { reservations: [], settlements: [], uncertain: false };
    if (entry.kind === 'reservation') group.reservations.push(entry);
    else if (entry.kind === 'settlement') group.settlements.push(entry);
    else group.uncertain = true;
    groups.set(key, group);
  }
  const totals: BudgetTotals = { userDailyUsd: 0, userMonthlyUsd: 0, globalDailyUsd: 0 };
  for (const entry of ledger) {
    const key = ledgerBudgetGroupKey(entry), group = key ? groups.get(key) : undefined;
    const reservation = group?.reservations.length === 1 && group.reservations[0].amountUsd >= 0 ? group.reservations[0] : undefined;
    let amount = Math.max(0, entry.amountUsd);
    if (entry.amountUsd < 0 && entry.kind === 'settlement' && reservation && group!.settlements.length === 1 && !group!.uncertain) {
      // A matched refund can release only this reservation, never another job's
      // commitment. Duplicate terminals or uncertain work keep a conservative hold.
      amount = Math.max(entry.amountUsd, -reservation.amountUsd);
    }
    const at = entry.kind === 'reservation' ? reservedAt(entry) : reservation ? reservedAt(reservation) : utc(entry.createdAt);
    if (at.slice(0,10) === day) { totals.globalDailyUsd += amount; if (entry.ownerId === ownerId) totals.userDailyUsd += amount; }
    if (entry.ownerId === ownerId && at.slice(0,7) === month) totals.userMonthlyUsd += amount;
  }
  // Rounding noise cannot become a credit against unrelated requests.
  totals.userDailyUsd = Math.max(0, totals.userDailyUsd); totals.userMonthlyUsd = Math.max(0, totals.userMonthlyUsd); totals.globalDailyUsd = Math.max(0, totals.globalDailyUsd);
  return totals;
}
