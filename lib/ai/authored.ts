import type { CoachOutput, InterviewProposal, Scenario, Session } from '../interview-practice/types';
import { buildEvidence } from '../interview-practice/evidence';

export function authoredQuestion(scenario: Scenario, session: Session): InterviewProposal {
  const questions = session.turns.filter(t => t.role === 'interviewer');
  if (questions.length >= 6) return { action: 'end_debrief', evidenceIds: [] };
  const probes = scenario.probes.filter(p => p.stageId === session.stageId);
  const probe = probes.find(p => !questions.some(t => t.text === p.question) && questions.filter(t => t.competencyId === p.competencyId).length < 3);
  if (!probe) return { action: 'end_debrief', evidenceIds: [] };
  const snapshot = buildEvidence(session).find(e => e.kind === 'snapshot');
  return { action: 'ask_probe', question: probe.question, competencyId: probe.competencyId, probeId: probe.id, evidenceIds: snapshot ? [snapshot.id] : [] };
}
export function observationOnlyReport(scenario: Scenario): CoachOutput {
  return {
    overview: 'AI coaching was unavailable. This report preserves your recorded work and next-practice links; it does not assess your skill. Inspect the actual code, test observations and discussion below.',
    rubric: scenario.rubric.map(c => ({ criterionId: c.id, level: 'Not observed', confidence: 'low', feedback: 'No validated AI or expert assessment was produced for this criterion. Recorded evidence remains available for your review.', evidenceIds: [] })),
    nextPractice: scenario.drills.slice(0, 2).map(d => ({ drillId: d.id, reason: 'An authored practice exercise related to this scenario. This suggestion does not imply a measured weakness.' }))
  };
}
