import { z } from 'zod';

// These are persistence contracts. Add a new schema version deliberately rather
// than silently stripping fields or interpreting an unknown event as another type.
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const requestId = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().min(1).max(max).refine(value => !value.includes('\0'));
const path = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,150}$/)
  .refine(value => !value.split('/').some(part => !part || part === '.' || part === '..'));
const envelope = {
  id: identifier,
  sessionId: identifier,
  sequence: z.number().int().safe().positive(),
  schemaVersion: z.literal(1),
  occurredAt: z.string().datetime({ offset: true }),
  recordedAt: z.string().datetime({ offset: true }),
  source: z.enum(['learner', 'server', 'runner', 'model']),
  requestId,
  causationId: identifier.optional(),
};
function event<T extends string, P extends z.ZodRawShape>(type: T, payload: P) {
  return z.object({ ...envelope, type: z.literal(type), payload: z.object(payload).strict() }).strict();
}

export const practiceEventSchema = z.discriminatedUnion('type', [
  event('session.started', { scenarioId: identifier, scenarioVersion: text(200), mode: z.enum(['practice', 'simulation']) }),
  event('workspace.saved', { snapshotId: identifier, sha256 }),
  event('stage.changed', { stageId: identifier, readyToSubmit: z.boolean().optional(), coachingRetry: z.boolean().optional() }),
  event('coding.finished', { snapshotId: identifier }),
  event('session.paused', {}),
  event('session.resumed', {}),
  event('session.submitted', { snapshotId: identifier }),
  event('test.requested', { jobId: identifier, snapshotId: identifier }),
  event('test.completed', { runId: identifier, jobId: identifier, snapshotId: identifier, status: z.enum(['completed', 'infrastructure_error', 'timeout']) }),
  // Empty competencyId is retained for existing v1 records; fresh questions are
  // separately checked against the authored rubric before append.
  event('interviewer.question', { turnId: identifier, competencyId: z.union([identifier, z.literal('')]), model: text(200) }),
  event('learner.answer-committed', { turnId: identifier, replyTo: identifier }),
  event('interview.interaction', { action: z.enum(['working', 'repeat', 'clarify']), response: text(6000), questionId: z.string().uuid().optional(), topic: z.enum(['requirements', 'assistance', 'timing']).optional() }).extend({ source: z.literal('learner') }),
  event('assistant.requested', { jobId: identifier, mode: z.enum(['ask', 'plan', 'edit']) }),
  event('assistant.responded', { jobId: identifier, model: text(200) }),
  event('assistant.edit-proposed', { jobId: identifier, proposalId: identifier, baseSnapshotId: identifier, baseSha256: sha256, paths: z.array(path).min(1).max(256).refine(paths => new Set(paths).size === paths.length) }),
  event('assistant.edit-decided', { proposalId: identifier, decision: z.enum(['accepted', 'rejected']) }),
  event('coaching.ready', { reportId: identifier, jobId: identifier }),
  event('coaching.corrected', { reportId: identifier, sourceReportId: identifier, generationId: identifier, reason: text(1000) }),
  event('operation.failed', { jobId: identifier, kind: z.enum(['run', 'interviewer', 'assistant', 'coach']).optional(), error: text(500) }),
  event('job.cancelled', { jobId: identifier }),
  event('hint.opened', { index: z.number().int().safe().nonnegative(), hint: text(20_000) }),
  event('drill.completed', { drillId: identifier, provenance: z.literal('learner-self-report') }),
]);

export type PracticeEvent = z.infer<typeof practiceEventSchema>;
export type EventType = PracticeEvent['type'];
export type EventPayload<T extends EventType> = Extract<PracticeEvent, { type: T }>['payload'];

/** Safe diagnostic messages never contain the rejected payload or Zod issues. */
export class EventValidationError extends Error {
  constructor(public readonly code: 'invalid_event' | 'unsupported_version' | 'invalid_sequence') {
    super(code === 'unsupported_version' ? 'Practice event schema version is unsupported.'
      : code === 'invalid_sequence' ? 'Practice event replay sequence is invalid.'
      : 'Practice event does not match its schema.');
    this.name = 'EventValidationError';
  }
}

/** Runtime validation applies equally to newly appended and persisted records. */
export function parsePracticeEvent(value: unknown): PracticeEvent {
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) {
    throw new EventValidationError('unsupported_version');
  }
  const result = practiceEventSchema.safeParse(value);
  if (!result.success) throw new EventValidationError('invalid_event');
  return result.data;
}

/** Sequence is the replay order; event wall clocks may legitimately differ. */
export function parseSessionEvents(events: unknown, sessionId: string): PracticeEvent[] {
  if (!Array.isArray(events) || !identifier.safeParse(sessionId).success) throw new EventValidationError('invalid_event');
  const ids = new Set<string>();
  return events.map((value, index) => {
    const parsed = parsePracticeEvent(value);
    if (parsed.sessionId !== sessionId || parsed.sequence !== index + 1 || ids.has(parsed.id)) {
      throw new EventValidationError('invalid_sequence');
    }
    ids.add(parsed.id);
    return parsed;
  });
}
