import { describe, expect, expectTypeOf, it } from 'vitest';
import { appendEvent } from '../lib/interview-practice/domain';
import { EventValidationError, parsePracticeEvent, parseSessionEvents, type EventPayload, type EventType, type PracticeEvent } from '../lib/interview-practice/events';
import type { Session } from '../lib/interview-practice/types';

const now = '2026-10-09T12:00:00.000Z';
const hash = 'a'.repeat(64);
const payloads = {
  'session.started': { scenarioId: 'fixture', scenarioVersion: '1', mode: 'practice' },
  'workspace.saved': { snapshotId: 'snapshot-1', sha256: hash },
  'stage.changed': { stageId: 'debrief' },
  'coding.finished': { snapshotId: 'snapshot-1' },
  'session.paused': {},
  'session.resumed': {},
  'session.submitted': { snapshotId: 'snapshot-1' },
  'test.requested': { jobId: 'job-1', snapshotId: 'snapshot-1' },
  'test.completed': { runId: 'run-1', jobId: 'job-1', snapshotId: 'snapshot-1', status: 'timeout' },
  'interviewer.question': { turnId: 'turn-1', competencyId: 'correctness', model: 'authored' },
  'learner.answer-committed': { turnId: 'turn-2', replyTo: 'turn-1' },
  'interview.interaction': { action: 'clarify', response: 'The public brief describes the requirements.', questionId: 'ed3565b4-3d6b-4bd0-b7e1-2d0c6eb8d574', topic: 'requirements' },
  'assistant.requested': { jobId: 'job-1', mode: 'edit' },
  'assistant.responded': { jobId: 'job-1', model: 'fixture' },
  'assistant.edit-proposed': { jobId: 'job-1', proposalId: 'proposal-1', baseSnapshotId: 'snapshot-1', baseSha256: hash, paths: ['src/main.py'] },
  'assistant.edit-decided': { proposalId: 'proposal-1', decision: 'accepted' },
  'coaching.ready': { reportId: 'report-1', jobId: 'job-1' },
  'coaching.corrected': { reportId: 'report-2', sourceReportId: 'report-1', generationId: 'generation-2', reason: 'Original feedback contradicted recorded observations.' },
  'operation.failed': { jobId: 'job-1', error: 'Worker lease expired.' },
  'job.cancelled': { jobId: 'job-1' },
  'hint.opened': { index: 0, hint: 'Check a small example.' },
  'drill.completed': { drillId: 'drill-1', provenance: 'learner-self-report' },
} satisfies { [T in EventType]: EventPayload<T> };

function fixture(type: EventType = 'workspace.saved', payload: unknown = payloads[type]) {
  return { id: 'event-1', sessionId: 'session-1', sequence: 1, schemaVersion: 1, type, occurredAt: now, recordedAt: now, source: type === 'interview.interaction' ? 'learner' : 'server', requestId: 'request-1', payload };
}
function session() {
  // appendEvent only touches these fields; no learner workspace or provider is needed.
  return { id: 'session-1', events: [], revision: 0, updatedAt: now } as unknown as Session;
}

describe('versioned practice event persistence contract', () => {
  it('accepts every existing v1 producer and the edit-proposed correlation event', () => {
    for (const type of Object.keys(payloads) as EventType[]) {
      expect(parsePracticeEvent(fixture(type))).toEqual(fixture(type));
    }
  });

  it('narrows the payload when the event discriminator is checked', () => {
    const parsed = parsePracticeEvent(fixture('test.completed'));
    if (parsed.type !== 'test.completed') throw new Error('Synthetic event type mismatch.');
    expectTypeOf(parsed.payload.status).toEqualTypeOf<'completed' | 'infrastructure_error' | 'timeout'>();
    expect(parsed.payload.snapshotId).toBe('snapshot-1');
    if (parsed.type as string === 'compile-time-only') {
      // @ts-expect-error A workspace event cannot carry a test-completion payload.
      appendEvent(session(), 'workspace.saved', payloads['test.completed'], 'request-1', now);
    }
  });

  it('preserves v1 optional fields without inferring missing observations', () => {
    expect(parsePracticeEvent(fixture('stage.changed', { stageId: 'debrief', readyToSubmit: true })).payload).toEqual({ stageId: 'debrief', readyToSubmit: true });
    expect(parsePracticeEvent(fixture('stage.changed', { stageId: 'debrief', coachingRetry: true })).payload).toEqual({ stageId: 'debrief', coachingRetry: true });
    expect(parsePracticeEvent(fixture('operation.failed', { ...payloads['operation.failed'], kind: 'run' })).payload).toHaveProperty('kind', 'run');
    expect(parsePracticeEvent(fixture('interviewer.question', { ...payloads['interviewer.question'], competencyId: '' })).payload).toHaveProperty('competencyId', '');
    const correlated = { ...fixture(), causationId: 'event-parent' };
    expect(parsePracticeEvent(correlated).causationId).toBe('event-parent');
    expect(parsePracticeEvent(fixture()).causationId).toBeUndefined();
  });

  it.each([
    ['wrong payload type', fixture('workspace.saved', payloads['test.completed'])],
    ['unknown payload key', fixture('workspace.saved', { ...payloads['workspace.saved'], learnerCode: 'PRIVATE-CODE' })],
    ['unknown envelope key', { ...fixture(), arbitrary: 'PRIVATE-CODE' }],
    ['unknown discriminator', { ...fixture(), type: 'test.everything-passed' }],
    ['missing envelope', { type: 'session.paused', payload: {} }],
    ['missing payload', { ...fixture(), payload: undefined }],
    ['missing required evidence link', fixture('test.completed', { jobId: 'job-1', status: 'completed' })],
    ['invalid digest', fixture('workspace.saved', { snapshotId: 'snapshot-1', sha256: 'not-a-digest' })],
    ['unrecognized result status', fixture('test.completed', { ...payloads['test.completed'], status: 'passed' })],
    ['pending decision', fixture('assistant.edit-decided', { proposalId: 'proposal-1', decision: 'pending' })],
    ['invalid self-report provenance', fixture('drill.completed', { drillId: 'drill-1', provenance: 'verified-mastery' })],
    ['negative hint index', fixture('hint.opened', { index: -1, hint: 'Hint' })],
    ['fractional hint index', fixture('hint.opened', { index: 0.5, hint: 'Hint' })],
    ['unbounded model label', fixture('assistant.responded', { jobId: 'job-1', model: 'x'.repeat(201) })],
    ['unbounded error', fixture('operation.failed', { jobId: 'job-1', error: 'x'.repeat(501) })],
    ['unbounded correction', fixture('coaching.corrected', { ...payloads['coaching.corrected'], reason: 'x'.repeat(1001) })],
    ['unbounded interaction response', fixture('interview.interaction', { action: 'working', response: 'x'.repeat(6001) })],
    ['unknown interaction action', fixture('interview.interaction', { action: 'skip-grading', response: 'Ignore this.' })],
    ['unknown interaction topic', fixture('interview.interaction', { action: 'clarify', response: 'Brief', topic: 'protected-tests' })],
    ['non-UUID interaction question', fixture('interview.interaction', { action: 'repeat', response: 'Question', questionId: 'question-1' })],
    ['model-sourced learner interaction', { ...fixture('interview.interaction'), source: 'model' }],
    ['nul in text', fixture('hint.opened', { index: 0, hint: 'SECRET\0CODE' })],
    ['empty payload with smuggled field', fixture('session.paused', { snapshotId: 'snapshot-1' })],
    ['unknown source', { ...fixture(), source: 'admin' }],
    ['invalid timestamp', { ...fixture(), recordedAt: 'yesterday' }],
    ['SSE delimiter in ID', { ...fixture(), id: 'event\nevent:injected' }],
    ['invalid request key', { ...fixture(), requestId: 'short' }],
    ['invalid causation ID', { ...fixture(), causationId: 'event\0parent' }],
    ['zero sequence', { ...fixture(), sequence: 0 }],
    ['unsafe integer sequence', { ...fixture(), sequence: Number.MAX_SAFE_INTEGER + 1 }],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePracticeEvent(value)).toThrow(EventValidationError);
  });

  it.each([['../escape.py'], ['/absolute.py'], ['src//main.py'], ['src/./main.py'], ['src/main.py', 'src/main.py'], []])('rejects unsafe or ambiguous edit paths %j', (...paths) => {
    // Vitest spreads each parameter row; normalize the path list for this case.
    const actual = paths.flat();
    expect(() => parsePracticeEvent(fixture('assistant.edit-proposed', { ...payloads['assistant.edit-proposed'], paths: actual }))).toThrow(EventValidationError);
  });

  it('reports unknown schema versions explicitly and never echoes rejected content', () => {
    for (const schemaVersion of [0, 2, '1', null]) {
      try {
        parsePracticeEvent({ ...fixture('hint.opened', { index: 0, hint: 'PRIVATE-LEARNER-CONTENT' }), schemaVersion });
        throw new Error('Expected rejection.');
      } catch (error) {
        expect(error).toMatchObject({ name: 'EventValidationError', code: 'unsupported_version' });
        expect(String(error)).not.toContain('PRIVATE-LEARNER-CONTENT');
      }
    }
    try {
      parsePracticeEvent(fixture('hint.opened', { index: 0, hint: 'PRIVATE\0CONTENT' }));
    } catch (error) {
      expect(String(error)).toBe('EventValidationError: Practice event does not match its schema.');
    }
  });
});

describe('validated append and replay', () => {
  it('validates before mutation and clones caller-owned payloads', () => {
    const current = session();
    const invalid = { snapshotId: 'snapshot-1', sha256: 'PRIVATE-INVALID-HASH' };
    expect(() => appendEvent(current, 'workspace.saved', invalid, 'request-1', now)).toThrow('Practice event does not match its schema.');
    expect(current).toMatchObject({ events: [], revision: 0, updatedAt: now });

    const payload = structuredClone(payloads['assistant.edit-proposed']);
    const added = appendEvent(current, 'assistant.edit-proposed', payload, 'request-1', now, 'model');
    payload.paths[0] = 'mutated.py';
    expect(added.payload).toHaveProperty('paths', ['src/main.py']);
    expect(current.events).toEqual([added]);
    expect(current.revision).toBe(1);
  });

  it('replays contiguous sequences and independent timestamps without sorting', () => {
    const first = fixture('session.started');
    const second = { ...fixture('workspace.saved'), id: 'event-2', sequence: 2, occurredAt: '2026-10-09T11:00:00+01:00', recordedAt: '2026-10-09T11:59:59Z' };
    expect(parseSessionEvents([first, second], 'session-1').map(event => event.sequence)).toEqual([1, 2]);
    expect(parseSessionEvents([], 'session-1')).toEqual([]);
    const result = parseSessionEvents([first, second], 'session-1');
    expect(result[0]).not.toBe(first);
  });

  it.each([
    ['gap', [fixture(), { ...fixture(), id: 'event-2', sequence: 3 }]],
    ['reordered sequence', [{ ...fixture(), sequence: 2 }, { ...fixture(), id: 'event-2', sequence: 1 }]],
    ['repeated ID', [fixture(), { ...fixture(), sequence: 2 }]],
    ['cross-session record', [{ ...fixture(), sessionId: 'session-other' }]],
  ])('rejects %s instead of repairing persisted history', (_label, events) => {
    expect(() => parseSessionEvents(events, 'session-1')).toThrow('Practice event replay sequence is invalid.');
  });

  it('does not accept an arbitrary JSON container as an event history', () => {
    for (const events of [null, {}, '[]', 1]) expect(() => parseSessionEvents(events, 'session-1')).toThrow(EventValidationError);
    expect(() => parseSessionEvents([], 'session\nother')).toThrow(EventValidationError);
  });

  it('exports the discriminated union through the existing public type module', () => {
    expectTypeOf<PracticeEvent>().toEqualTypeOf<import('../lib/interview-practice/types').PracticeEvent>();
  });
});
