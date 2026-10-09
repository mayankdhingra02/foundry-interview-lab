import 'server-only';
import { createHmac } from 'node:crypto';
import { telemetryObservation, type TelemetryObservation, type TelemetryOrigin } from '../interview-practice/telemetry';
import type { SessionView } from '../interview-practice/types';

type TelemetryConfig = { secret: string; sink: 'stdout' };
export function telemetryConfig(): TelemetryConfig | null {
  const secret = process.env.PRACTICE_TELEMETRY_SECRET;
  return process.env.FEATURE_PRACTICE_TELEMETRY === 'true' && process.env.PRACTICE_TELEMETRY_SINK === 'stdout'
    && typeof secret === 'string' && secret.length >= 32 && secret.length <= 256 ? { secret, sink: 'stdout' } : null;
}
const token = (secret: string, category: string, values: string[]) => createHmac('sha256', secret).update(JSON.stringify([category, ...values])).digest('hex');

/** Best effort only. A diagnostic sink cannot fail or roll back learner work. */
export function emitTelemetry(ownerId: string, sessionId: string, logicalId: string, observation: TelemetryObservation, options: { origin?: TelemetryOrigin; jobId?: string; now?: Date; write?: (line: string) => void } = {}): boolean {
  try {
    const config = telemetryConfig(), parsed = telemetryObservation.safeParse(observation);
    if (!config || !parsed.success || !ownerId || !sessionId || !logicalId) return false;
    const record = {
      schemaVersion: 1, channel: 'foundry.practice.telemetry',
      eventId: token(config.secret, 'event', [ownerId, sessionId, logicalId, parsed.data.event]),
      actorToken: token(config.secret, 'actor', [ownerId]),
      sessionToken: token(config.secret, 'session', [ownerId, sessionId]),
      ...(options.jobId ? { jobToken: token(config.secret, 'job', [ownerId, sessionId, options.jobId]) } : {}),
      origin: options.origin === 'browser-unverified' ? 'browser-unverified' : 'server',
      observedAt: (options.now ?? new Date()).toISOString(), ...parsed.data,
    };
    (options.write ?? console.info)(JSON.stringify(record));
    return true;
  } catch { return false; }
}

/** Exact durable mutation events supply facts and repeatable collector dedup IDs. */
export function emitMutationTelemetry(ownerId: string, session: SessionView, requestId: string) {
  if (!telemetryConfig()) return;
  for (const event of session.events.filter(item => item.requestId === requestId)) {
    const observation: TelemetryObservation | null = event.type === 'session.started'
      ? { event: 'practice.started', mode: session.mode }
      : event.type === 'session.submitted' ? { event: 'practice.submitted', mode: session.mode }
      : event.type === 'assistant.requested' ? { event: 'assistance.requested', mode: event.payload.mode }
      : event.type === 'drill.completed' ? { event: 'focused-drill.completed', provenance: 'learner-self-report' }
      : null;
    if (observation) emitTelemetry(ownerId, session.id, event.id, observation, { now: new Date(event.occurredAt), ...('jobId' in event.payload ? { jobId: event.payload.jobId } : {}) });
  }
}

/** Bounds one process; shared-ingress admission remains a deployment concern. */
export class BrowserObservationGate {
  private owners = new Map<string, { window: number; count: number; ids: Map<string, number> }>();
  constructor(private readonly now: () => number = Date.now) {}
  admit(ownerId: string, eventId: string): 'accepted' | 'duplicate' | 'limited' {
    const now = this.now();
    for (const [owner, entry] of this.owners) if (now - entry.window >= 600_000) this.owners.delete(owner);
    let entry = this.owners.get(ownerId);
    if (!entry) {
      if (this.owners.size >= 1_000) return 'limited';
      entry = { window: now, count: 0, ids: new Map() }; this.owners.set(ownerId, entry);
    }
    for (const [id, clock] of entry.ids) if (now - clock >= 600_000) entry.ids.delete(id);
    if (entry.ids.has(eventId)) return 'duplicate';
    if (now - entry.window >= 60_000) { entry.window = now; entry.count = 0; }
    if (entry.count >= 30 || entry.ids.size >= 300) return 'limited';
    entry.count++; entry.ids.set(eventId, now); return 'accepted';
  }
}
export const browserObservationGate = new BrowserObservationGate();
