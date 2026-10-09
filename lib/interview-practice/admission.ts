import { DomainError } from './domain';
import type { PracticeDatabase, RequestRecord } from './types';

export type AdmissionLimits = {
  ownerMutationsPerMinute: number; ownerMutationsPerDay: number;
  ownerSavesPerMinute: number; ownerSavesPerDay: number;
  ownerSessions: number; ownerRequests: number; sessionSnapshots: number; sessionEvents: number;
  globalInFlightJobs: number; ownerInFlightJobs: number;
};
export const DEFAULT_ADMISSION_LIMITS: AdmissionLimits = {
  ownerMutationsPerMinute: 30, ownerMutationsPerDay: 1000,
  ownerSavesPerMinute: 90, ownerSavesPerDay: 5000,
  ownerSessions: 50, ownerRequests: 5000, sessionSnapshots: 512, sessionEvents: 3000,
  globalInFlightJobs: 20, ownerInFlightJobs: 4,
};
export type MutationLane = 'workspace' | 'ordinary' | 'recovery' | 'staff';
type AdmissionMetadata = { admission: { version: 1; lane: MutationLane } };
type Growth = { sessions: Map<string, { snapshots: number; events: number }>; globalJobs: number; ownerJobs: number };
const DAY = 86_400_000, MINUTE = 60_000;
const quota = (message: string): never => { throw new DomainError('quota', message); };

export function admissionLimits(overrides: Partial<AdmissionLimits> = {}): AdmissionLimits {
  const limits = { ...DEFAULT_ADMISSION_LIMITS, ...overrides };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1 || value > 1_000_000)) throw new DomainError('invalid', 'Practice admission limits must be positive bounded integers.');
  return limits;
}
export function admissionLimitsFromEnvironment(env: Record<string, string | undefined>): AdmissionLimits {
  const names: Record<keyof AdmissionLimits, string> = {
    ownerMutationsPerMinute: 'PRACTICE_OWNER_MUTATIONS_PER_MINUTE', ownerMutationsPerDay: 'PRACTICE_OWNER_MUTATIONS_PER_DAY',
    ownerSavesPerMinute: 'PRACTICE_OWNER_SAVES_PER_MINUTE', ownerSavesPerDay: 'PRACTICE_OWNER_SAVES_PER_DAY',
    ownerSessions: 'PRACTICE_MAX_OWNER_HISTORY', ownerRequests: 'PRACTICE_MAX_OWNER_REQUESTS',
    sessionSnapshots: 'PRACTICE_MAX_SESSION_SNAPSHOTS', sessionEvents: 'PRACTICE_MAX_SESSION_EVENTS',
    globalInFlightJobs: 'PRACTICE_MAX_GLOBAL_PENDING_JOBS', ownerInFlightJobs: 'PRACTICE_MAX_OWNER_PENDING_JOBS',
  };
  const overrides: Partial<AdmissionLimits> = {};
  for (const [key, name] of Object.entries(names)) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    if (!/^[1-9]\d{0,6}$/.test(value)) throw new DomainError('invalid', `${name} must be a positive bounded integer.`);
    overrides[key as keyof AdmissionLimits] = Number(value);
  }
  return admissionLimits(overrides);
}
function lane(record: RequestRecord): MutationLane | undefined {
  const metadata = (record as RequestRecord & Partial<AdmissionMetadata>).admission;
  return metadata?.version === 1 && ['workspace', 'ordinary', 'recovery', 'staff'].includes(metadata.lane) ? metadata.lane : undefined;
}
export function mutationLane(database: PracticeDatabase, ownerId: string, operation: string, payload: unknown, sessionId?: string): MutationLane {
  if (operation === 'workspace') return 'workspace';
  if (operation === 'delete-session') return 'recovery';
  if (operation === 'delete-account') {
    const hasSessions = Object.values(database.sessions).some(session => session.ownerId === ownerId);
    const onlyDeletionAcknowledgments = Object.values(database.requests).filter(record => record.ownerId === ownerId).every(record => {
      const result = record.result;
      return result !== null && typeof result === 'object' && Object.getPrototypeOf(result) === Object.prototype && Object.keys(result).length === 1 && (result as { deleted?: unknown }).deleted === true;
    });
    return !hasSessions && onlyDeletionAcknowledgments ? 'ordinary' : 'recovery';
  }
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (operation === 'command' && ['finish', 'submit', 'resume'].includes(String(body.action))) return 'recovery';
  if (operation === 'cancel-job') {
    const job = Object.values(database.sessions).filter(session => session.ownerId === ownerId).flatMap(session => session.jobs).find(job => job.id === body.jobId);
    if (job && ['queued', 'running'].includes(job.state)) return 'recovery';
  }
  if (operation === 'retry-report') {
    const session = sessionId ? database.sessions[sessionId] : undefined;
    if (session?.ownerId === ownerId && !session.reports.length && session.jobs.some(job => job.kind === 'coach' && ['failed', 'cancelled'].includes(job.state))) return 'recovery';
  }
  return 'ordinary';
}
export function mutationAdmissionMetadata(value: MutationLane): AdmissionMetadata { return { admission: { version: 1, lane: value } }; }

/** Call only after exact replay and ownership checks, inside the store lock. */
export function assertMutationAdmission(database: PracticeDatabase, ownerId: string, operation: string, value: MutationLane, now: string, limits: AdmissionLimits): void {
  if (value === 'recovery') return;
  const clock = Date.parse(now); if (!Number.isFinite(clock)) throw new DomainError('unavailable', 'Practice admission clock is unavailable. Your acknowledged work is preserved.');
  const owned = Object.values(database.requests).filter(record => record.ownerId === ownerId && lane(record) !== 'staff');
  if (owned.length >= limits.ownerRequests) quota('Saved request history has reached this account’s safe capacity. Export or delete older attempts before new work; cancellation, final submission and deletion remain available.');
  if (operation === 'create' && Object.values(database.sessions).filter(session => session.ownerId === ownerId).length >= limits.ownerSessions) quota('Saved attempt history has reached this account’s safe capacity. Export or delete an older attempt before starting another.');
  let minute = 0, day = 0;
  for (const record of owned) {
    const recordLane = lane(record); if (recordLane === 'recovery' || (recordLane !== undefined && recordLane !== value)) continue;
    const created = Date.parse(record.createdAt);
    if (!Number.isFinite(created) || created > clock) throw new DomainError('unavailable', 'Practice admission history needs operator review. Acknowledged work and deletion remain available.');
    // The lower boundary is exclusive: at exactly one full window old, a
    // successful mutation stops consuming that rolling window.
    if (created > clock - DAY) day++;
    if (created > clock - MINUTE) minute++;
  }
  const minuteLimit = value === 'workspace' ? limits.ownerSavesPerMinute : limits.ownerMutationsPerMinute;
  const dayLimit = value === 'workspace' ? limits.ownerSavesPerDay : limits.ownerMutationsPerDay;
  if (minute >= minuteLimit) quota(value === 'workspace' ? 'Workspace saves are arriving too quickly. Keep your local draft and retry after a minute; acknowledged files are preserved.' : 'Too many practice actions were acknowledged in the last minute. Retry after a minute; workspace saving and recovery remain available.');
  if (day >= dayLimit) quota(value === 'workspace' ? 'This account has reached its rolling 24-hour save allowance. Keep or download your local draft. Acknowledged files, final submission and deletion remain available.' : 'This account has reached its rolling 24-hour practice-action allowance. Workspace saving and recovery remain available.');
}
export function captureMutationGrowth(database: PracticeDatabase, ownerId: string): Growth {
  const sessions = Object.values(database.sessions), owned = sessions.filter(session => session.ownerId === ownerId);
  const pending = (ownerOnly: boolean) => sessions.filter(session => !ownerOnly || session.ownerId === ownerId).reduce((sum, session) => sum + session.jobs.filter(job => job.state === 'queued' || job.state === 'running').length, 0);
  return { sessions: new Map(owned.map(session => [session.id, { snapshots: session.snapshots.length, events: session.events.length }])), globalJobs: pending(false), ownerJobs: pending(true) };
}
export function assertJobAdmission(database: PracticeDatabase, ownerId: string, limits: AdmissionLimits): void {
  const growth = captureMutationGrowth(database, ownerId);
  if (growth.ownerJobs >= limits.ownerInFlightJobs) quota('This account already has the maximum pending operations. Wait for one to finish or cancel it; workspace saving remains available.');
  if (growth.globalJobs >= limits.globalInFlightJobs) quota('Practice processing is at capacity. Wait and retry; workspace saving and recovery remain available.');
}
/** Roll back the attempted mutation, never prune already acknowledged evidence. */
export function assertMutationGrowth(database: PracticeDatabase, ownerId: string, before: Growth, value: MutationLane, limits: AdmissionLimits): void {
  const after = captureMutationGrowth(database, ownerId);
  if ((after.globalJobs > before.globalJobs && after.globalJobs > limits.globalInFlightJobs) || (after.ownerJobs > before.ownerJobs && after.ownerJobs > limits.ownerInFlightJobs)) quota('Practice processing is at capacity. Wait or cancel pending work; acknowledged files remain saved.');
  if (value === 'recovery') return;
  for (const session of Object.values(database.sessions).filter(session => session.ownerId === ownerId)) {
    const prior = before.sessions.get(session.id);
    if (session.snapshots.length > (prior?.snapshots ?? 0) && session.snapshots.length > limits.sessionSnapshots) quota('This attempt has reached its saved-snapshot capacity. The new edit was not acknowledged. Keep or download your local draft, then finish or export this attempt; existing snapshots are preserved.');
    if (session.events.length > (prior?.events ?? 0) && session.events.length > limits.sessionEvents) quota('This attempt has reached its activity-history capacity. Acknowledged work is preserved. Finish, export or delete the attempt instead of adding new activity.');
  }
}
