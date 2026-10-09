import 'server-only';
import { listScenarioSummaries } from '../content/scenarios';
import { HttpError } from './http';
import type { SessionAdmissionContext } from './session-service';

type AdmissionMode = 'staff' | 'invite' | 'open';
type Allowlist = { valid: boolean; ids: Set<string> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const closed = () => new HttpError(503, 'rollout_unconfigured', 'New practice admission is unavailable. Saved attempts remain accessible.');

function exactList(value: string | undefined, allowed: (id: string) => boolean): Allowlist {
  if (value === undefined || value === '') return { valid: true, ids: new Set() };
  if (value.length > 65_536) return { valid: false, ids: new Set() };
  const entries = value.split(',').map(id => id.trim());
  if (entries.some(id => !id || !allowed(id)) || new Set(entries).size !== entries.length) return { valid: false, ids: new Set() };
  return { valid: true, ids: new Set(entries) };
}
function scenarioAllowlist(): Allowlist {
  const known = new Set(listScenarioSummaries().map(scenario => scenario.id));
  const value = process.env.PRACTICE_ADMITTED_SCENARIOS;
  if (value === undefined) return { valid: true, ids: process.env.NODE_ENV === 'production' ? new Set() : known };
  return exactList(value, id => known.has(id));
}
function ownerPolicy() {
  const mode = process.env.PRACTICE_ADMISSION_MODE ?? (process.env.NODE_ENV === 'production' ? 'staff' : 'open');
  const staff = exactList(process.env.ADMIN_USER_IDS, id => uuid.test(id));
  const invited = exactList(process.env.INVITED_PRACTICE_USER_IDS, id => uuid.test(id));
  return { mode: mode as AdmissionMode, staff: staff.ids, invited: invited.ids, valid: ['staff', 'invite', 'open'].includes(mode) && staff.valid && invited.valid };
}

/** Retirement filters new practice only; it never changes package resolution. */
export function admittedScenarios<T extends { id: string }>(catalog: T[]): T[] {
  const policy = scenarioAllowlist();
  return policy.valid ? catalog.filter(scenario => policy.ids.has(scenario.id)) : [];
}

/** Apply inside the transactional new-admission callback, after request replay. */
export function assertScenarioAdmission(id: string): void {
  const policy = scenarioAllowlist();
  if (!policy.valid) throw closed();
  if (!policy.ids.has(id)) throw new HttpError(403, 'scenario_not_admitted', 'This scenario is not accepting new attempts. Saved attempts remain accessible.');
}

/** The owner ID must come from the existing verified server actor. */
export function assertPracticeAdmission(ownerId: string): void {
  const policy = ownerPolicy();
  if (!policy.valid) throw closed();
  const allowed = policy.mode === 'open' || policy.staff.has(ownerId) || (policy.mode === 'invite' && policy.invited.has(ownerId));
  if (!ownerId || !allowed) throw new HttpError(403, 'practice_not_admitted', 'New practice is limited to the current rollout group. Saved attempts remain accessible.');
}

/** Deny before the billing hook can consume an entitlement or write a debit. */
export function rolloutAdmissionPolicy(next?: (context: SessionAdmissionContext) => Promise<void>) {
  return async (context: SessionAdmissionContext): Promise<void> => {
    assertScenarioAdmission(context.scenarioId);
    assertPracticeAdmission(context.ownerId);
    await next?.(context);
  };
}
