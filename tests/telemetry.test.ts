import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserObservation, telemetryObservation } from '../lib/interview-practice/telemetry';
import { BrowserObservationGate, emitMutationTelemetry, emitTelemetry, telemetryConfig } from '../lib/server/telemetry';
import { getScenario } from '../lib/content/scenarios';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';

function enable() { vi.stubEnv('FEATURE_PRACTICE_TELEMETRY', 'true'); vi.stubEnv('PRACTICE_TELEMETRY_SINK', 'stdout'); vi.stubEnv('PRACTICE_TELEMETRY_SECRET', 'telemetry-test-secret-that-is-not-real'); }
beforeEach(() => { vi.stubEnv('FEATURE_PRACTICE_TELEMETRY', 'false'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('bounded telemetry independent of learner evidence', () => {
  it('is off by default and fails closed for incomplete or unsupported collector settings', () => {
    const write = vi.fn(), observation = { event: 'practice.started' as const, mode: 'practice' as const };
    expect(emitTelemetry('owner', 'session', 'event', observation, { write })).toBe(false); expect(write).not.toHaveBeenCalled();
    enable(); vi.stubEnv('PRACTICE_TELEMETRY_SECRET', 'short'); expect(telemetryConfig()).toBeNull();
    vi.stubEnv('PRACTICE_TELEMETRY_SECRET', 'x'.repeat(32)); vi.stubEnv('PRACTICE_TELEMETRY_SINK', 'https://arbitrary.invalid'); expect(telemetryConfig()).toBeNull();
  });
  it('hashes raw identities with a separate secret, correlates exact jobs, and uses stable collector dedup IDs', () => {
    enable(); const lines: string[] = [], write = (line: string) => lines.push(line);
    const input = { event: 'latency.measured' as const, metric: 'run.result' as const, durationMs: 12, outcome: 'acknowledged' as const };
    emitTelemetry('private-owner', 'private-session', 'private-event', input, { jobId: 'private-job', write });
    emitTelemetry('private-owner', 'private-session', 'private-event', input, { jobId: 'private-job', write });
    const [a, b] = lines.map(line => JSON.parse(line));
    expect(a.eventId).toBe(b.eventId); expect(a.jobToken).toBe(b.jobToken); expect(a.actorToken).not.toBe(a.sessionToken);
    expect(a).toMatchObject({ schemaVersion: 1, origin: 'server', durationMs: 12 });
    expect(lines.join('')).not.toMatch(/private-(owner|session|event|job)|telemetry-test-secret/);
    vi.stubEnv('PRACTICE_TELEMETRY_SECRET', 'different-secret-with-at-least-32-characters');
    emitTelemetry('private-owner', 'private-session', 'private-event', input, { jobId: 'private-job', write });
    expect(JSON.parse(lines[2]).actorToken).not.toBe(a.actorToken);
  });
  it('rejects arbitrary content, unsupported claims, nonfinite values and oversized intervals', () => {
    const base = { event: 'latency.measured', metric: 'workspace.save', eventId: randomUUID(), durationMs: 12, outcome: 'acknowledged' };
    for (const extra of [{ code: 'SECRET' }, { transcript: 'PRIVATE' }, { error: 'credential' }, { url: '/private' }, { actorId: 'user' }, { durationMs: Infinity }, { durationMs: -1 }, { durationMs: 3_600_001 }, { event: 'practice.started' }]) expect(browserObservation.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(telemetryObservation.safeParse({ event: 'unseen-retest.completed', priorFocusedDrill: true }).success).toBe(false);
    enable(); const write = vi.fn();
    expect(emitTelemetry('owner', 'session', 'event', { event: 'practice.started', mode: 'practice', content: 'PRIVATE' } as never, { write })).toBe(false); expect(write).not.toHaveBeenCalled();
    expect(emitTelemetry('owner', 'session', 'event', { event: 'practice.started', mode: 'practice' }, { write: () => { throw new Error('sink failed'); } })).toBe(false);
  });
  it('bounds browser owners, per-minute observations and replay cache without dispatching work', () => {
    let now = 100_000; const gate = new BrowserObservationGate(() => now);
    expect(gate.admit('owner', 'first')).toBe('accepted'); expect(gate.admit('owner', 'first')).toBe('duplicate');
    for (let i = 1; i < 30; i++) expect(gate.admit('owner', `event-${i}`)).toBe('accepted');
    expect(gate.admit('owner', 'overflow')).toBe('limited'); now += 60_000; expect(gate.admit('owner', 'overflow')).toBe('accepted');
    for (let i = 1; i < 1_000; i++) expect(gate.admit(`owner-${i}`, 'one')).toBe('accepted');
    expect(gate.admit('extra-owner', 'one')).toBe('limited'); now += 600_000; expect(gate.admit('extra-owner', 'one')).toBe('accepted');
  });
  it('emits only durable request-bound product facts and never mutates attempts or copies payloads', async () => {
    enable(); const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const service = new SessionService(new MemoryPracticeStore(), getScenario), key = randomUUID();
    const { session } = await service.createSession('owner', { scenarioId: 'monetary-validation', requestId: key });
    const before = structuredClone(session); emitMutationTelemetry('owner', session, key); emitMutationTelemetry('owner', session, key);
    const records = log.mock.calls.map(([line]) => JSON.parse(line));
    expect(records).toHaveLength(2); expect(records[0].event).toBe('practice.started'); expect(records[0].eventId).toBe(records[1].eventId);
    expect(session).toEqual(before); expect(records[0]).not.toHaveProperty('payload'); expect(JSON.stringify(records)).not.toContain('quote.py');
    emitMutationTelemetry('owner', session, randomUUID()); expect(log).toHaveBeenCalledTimes(2);
  });
});
