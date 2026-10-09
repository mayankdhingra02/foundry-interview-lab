import { createHash, randomUUID } from 'node:crypto';
import { EventValidationError, parsePracticeEvent, type EventPayload } from './events';
import type { EventType, PracticeEvent, PublicScenario, Scenario, Session, Snapshot } from './types';

export class DomainError extends Error {
  constructor(public readonly code: 'invalid' | 'not_found' | 'conflict' | 'quota' | 'unavailable', message: string, public readonly status = code === 'not_found' ? 404 : code === 'conflict' ? 409 : code === 'quota' ? 429 : code === 'unavailable' ? 503 : 400) {
    super(message); this.name = 'DomainError';
  }
}
export { DomainError as PracticeError };
export function canonical(value: unknown): string {
  if (value === undefined) throw new DomainError('invalid', 'Undefined is not a canonical value.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new DomainError('invalid', 'Use finite numbers.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new DomainError('invalid', 'Unsupported value.');
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const textDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export function requestKey(ownerId: string, requestId: string) { return `${ownerId}:${requestId}`; }
export function assertRequestId(value: string) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new DomainError('invalid', 'Use a unique request key of 8–128 letters, digits or hyphens.');
}
export function ownedSession(sessions: Record<string, Session>, ownerId: string, id: string): Session {
  const session = sessions[id];
  if (!session || session.ownerId !== ownerId) throw new DomainError('not_found', 'Practice session not found.');
  return session;
}
export function assertRevision(session: Session, revision: number) {
  if (!Number.isSafeInteger(revision) || revision !== session.revision) throw new DomainError('conflict', `This session changed. Reload revision ${session.revision} before saving.`);
}
export function assertActive(session: Session) {
  if (session.lifecycle !== 'active') throw new DomainError('conflict', 'Resume an active session before continuing.');
}
export function assertCoding(session: Session) {
  assertActive(session);
  if (session.codeFrozenSnapshotId) throw new DomainError('conflict', 'Coding is finished. Start a new attempt to change the frozen code.');
}
export function validateFiles(files: unknown, scenario: Pick<Scenario, 'files'>): Record<string, string> {
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.getPrototypeOf(files) !== Object.prototype) throw new DomainError('invalid', 'Provide workspace files.');
  const expected = Object.keys(scenario.files).sort(), actual = Object.keys(files).sort();
  if (canonical(expected) !== canonical(actual)) throw new DomainError('invalid', 'Workspace must contain exactly the scenario files.');
  const safe: Record<string, string> = {};
  let bytes = 0;
  for (const path of expected) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/.test(path) || path.split('/').some(s => s === '.' || s === '..' || !s)) throw new DomainError('invalid', 'Unsafe workspace path.');
    const content = (files as Record<string, unknown>)[path];
    if (typeof content !== 'string' || content.includes('\0') || Buffer.byteLength(content) > 64_000) throw new DomainError('invalid', 'Each workspace file must be at most 64 KB of text.');
    bytes += Buffer.byteLength(content); safe[path] = content;
  }
  if (bytes > 256_000) throw new DomainError('invalid', 'Workspace exceeds 256 KB.');
  return safe;
}
export function toPublicScenario(scenario: Scenario): PublicScenario {
  const { referenceFiles: _references, probes: _probes, hints: _hints, tests, ...publicFields } = structuredClone(scenario);
  void _references; void _probes; void _hints;
  return { ...publicFields, tests: tests.map(({ source, ...metadata }) => metadata.visible ? { ...metadata, source } : metadata) };
}
export function appendEvent<T extends EventType>(session: Session, type: T, payload: EventPayload<T>, requestId: string, now: string, source: PracticeEvent['source'] = 'server'): PracticeEvent {
  let event: PracticeEvent;
  try {
    event = parsePracticeEvent({ id: randomUUID(), sessionId: session.id, sequence: session.events.length + 1, schemaVersion: 1, type, payload, requestId, source, occurredAt: now, recordedAt: now });
  } catch (error) {
    if (error instanceof EventValidationError) throw new DomainError('invalid', error.message);
    throw error;
  }
  session.events.push(event); session.revision += 1; session.updatedAt = now;
  return event;
}
export function createSnapshot(session: Session, files: Record<string, string>, now: string): Snapshot {
  const sha256 = digest(files), latest = session.snapshots.at(-1);
  if (latest?.sha256 === sha256) return latest;
  const snapshot = { id: randomUUID(), sequence: session.snapshots.length + 1, sha256, files: structuredClone(files), createdAt: now };
  session.snapshots.push(snapshot); return snapshot;
}
export function selectedSnapshot(session: Session): Snapshot {
  const snapshot = session.codeFrozenSnapshotId ? session.snapshots.find(s => s.id === session.codeFrozenSnapshotId) : session.snapshots.at(-1);
  if (!snapshot) throw new DomainError('unavailable', 'Workspace snapshot is unavailable.');
  return snapshot;
}
export function boundedText(value: unknown, label: string, max = 6000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new DomainError('invalid', `${label} must contain 1–${max} characters.`);
  return value.trim();
}
