import { appendEvent, assertActive, assertRequestId, assertRevision, digest, DomainError, ownedSession, requestKey } from '../interview-practice/domain';
import type { Mutation, SessionView } from '../interview-practice/types';
import type { PracticeStore } from './store';
import { sessionView } from './session-service';
import { assertRequestNotErased } from './deleted-requests';

export type InteractionAction = 'working' | 'repeat' | 'clarify';
export type ClarificationTopic = 'requirements' | 'assistance' | 'timing';
export type InteractionInput = Mutation & { action: InteractionAction; topic?: ClarificationTopic };
export type InteractionResult = { session: SessionView; response: string; questionId?: string };

/** Public-brief controls are deterministic. They never submit an answer or call a provider. */
export class InteractionService {
  constructor(private readonly store: PracticeStore, private readonly now = () => new Date()) {}
  async interact(ownerId: string, sessionId: string, input: InteractionInput): Promise<InteractionResult> {
    assertRequestId(input.requestId);
    if (!['working', 'repeat', 'clarify'].includes(input.action) ||
        (input.topic !== undefined && (!['requirements', 'assistance', 'timing'].includes(input.topic) || input.action !== 'clarify'))) {
      throw new DomainError('invalid', 'Choose a supported interview control.');
    }
    const topic = input.action === 'clarify' ? input.topic ?? 'requirements' : undefined;
    const fingerprint = digest({ operation: 'interview-interaction', sessionId, action: input.action, topic: topic ?? null });
    return this.store.transaction(db => {
      const key = requestKey(ownerId, input.requestId), prior = db.requests[key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new DomainError('conflict', 'This request key was already used for different input.');
        return structuredClone(prior.result) as InteractionResult;
      }
      assertRequestNotErased(db, ownerId, input.requestId, fingerprint);
      const session = ownedSession(db.sessions, ownerId, sessionId);
      assertRevision(session, input.expectedRevision); assertActive(session);
      if (session.frozenEvidence) throw new DomainError('conflict', 'Final submission has closed interview controls.');
      if (session.events.filter(event => event.type === 'interview.interaction').length >= 100) throw new DomainError('quota', 'This attempt has reached its interview-control limit. Saved instructions and questions remain available.');
      let response: string, questionId: string | undefined;
      if (input.action === 'working') {
        response = 'You can continue at your pace. This records that you are working; it does not submit an answer or pause the attempt. Elapsed time is advisory.';
      } else if (input.action === 'repeat') {
        const question = session.turns.filter(turn => turn.role === 'interviewer').at(-1);
        if (!question) throw new DomainError('conflict', 'There is no committed interview question to repeat yet.');
        response = question.text; questionId = question.id;
      } else if (topic === 'assistance') {
        response = `${session.configuration.aiHelp ? 'The coding assistant is permitted when it is available. You review and accept any proposed file changes.' : 'Coding assistance is off under the policy selected for this attempt.'} ${session.mode === 'practice' ? 'Authored hints and pausing are available in practice mode.' : 'Authored hints are unavailable in simulation mode; your selected help policy stays fixed.'} Asking to repeat or clarify instructions does not count as a graded answer.`;
      } else if (topic === 'timing') {
        response = `Your target is ${session.configuration.targetMinutes} minutes. The displayed clock is advisory wall time, including interruptions; it does not automatically submit or grade your work. Choose Finish coding to freeze the implementation, then Final submit when your discussion is complete.`;
      } else {
        const stage = session.scenario.stages.find(item => item.id === session.stageId);
        response = [session.scenario.summary, stage?.brief, ...(stage?.requirements ?? [])].filter(Boolean).join('\n\n');
        if (response.length > 5900) response = `${response.slice(0, 5900)}\n\nSee the Task panel for the remaining published requirements.`;
      }
      const now = this.now().toISOString();
      appendEvent(session, 'interview.interaction', { action: input.action, response, ...(topic ? { topic } : {}), ...(questionId ? { questionId } : {}) }, input.requestId, now, 'learner');
      const result = { session: sessionView(session), response, ...(questionId ? { questionId } : {}) };
      db.requests[key] = { ownerId, sessionId, requestId: input.requestId, fingerprint, createdAt: now, result: structuredClone(result) };
      return result;
    });
  }
}
