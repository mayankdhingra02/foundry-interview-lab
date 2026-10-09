import { randomUUID } from 'node:crypto';
import type { CoachOutput, Scenario } from '../lib/interview-practice/types';
import { ReviewService } from '../lib/server/review-service';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore, type PracticeStore } from '../lib/server/store';
export const owner = '73efbd73-729b-4b58-80ab-8c67240ef3db', other = '51c77415-21f8-4305-b165-c29eb5d3c829';
export const author = { id: '11dc5c01-f748-46b7-b699-0b55f316a3c6', local: false }, reviewer = { id: '5222fa22-120a-4cf5-89ed-7dad687b3c9b', local: false };
export const requestId = () => randomUUID();
export const scenario: Scenario = { id: 'review-fixture', version: '1', title: 'Original review fixture', summary: 'Synthetic review protocol', durationMinutes: 30, level: 'mid', tags: ['correctness'], language: 'python', files: { 'main.py': 'PRIVATE-LEARNER-CODE\n' }, stages: [{ id: 'debug', title: 'Work', brief: 'Inspect', requirements: ['Inspect behavior'] }, { id: 'debrief', title: 'Discuss', brief: 'Explain', requirements: ['Explain checks'] }], rubric: [{ id: 'correctness', name: 'Correctness', description: 'Observed behavior', anchors: { strong: 'Verified', developing: 'Partial', needsWork: 'Missing' } }], probes: [{ id: 'p1', stageId: 'debrief', competencyId: 'correctness', question: 'What did you check?' }], hints: [], tests: [{ id: 'smoke', title: 'Smoke', source: 'assert True', visible: true, timeoutSeconds: 1 }], referenceFiles: { 'main.py': 'PRIVATE-AUTHOR-REFERENCE' }, drills: [{ id: 'drill', title: 'A check', competencyId: 'correctness', lesson: 'Check an example', exercise: 'Try a boundary' }], rights: 'Original synthetic fixture', runtime: { image: 'python:3.11-slim', timeoutSeconds: 2, memoryMb: 128 } };
export function harness(store: PracticeStore = new MemoryPracticeStore(), now?: () => Date) {
  const practice = new SessionService(store, () => structuredClone(scenario), { now });
  const reviews = new ReviewService(store, () => structuredClone(scenario), { now, adminUserIds: [author.id, reviewer.id], practice });
  return { store, practice, reviews };
}
export async function finalAttempt(context: ReturnType<typeof harness>, failCoach = false) {
  const { practice } = context;
  let session = (await practice.createSession(owner, { scenarioId: scenario.id, requestId: requestId() })).session;
  await practice.requestRun(owner, session.id, { requestId: requestId(), expectedRevision: session.revision }); const run = await practice.claimJob('fixture-worker');
  await practice.completeJob(run!, { kind: 'run', run: { status: 'completed', command: 'synthetic test fixture', stdout: '', stderr: '', exitCode: 1, durationMs: 1, tests: [{ id: 'smoke', title: 'Smoke', status: 'failed' }] } });
  session = await practice.getSession(owner, session.id);
  const finish = await practice.command(owner, session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'finish' });
  await practice.cancelJob(owner, finish.job!.id, { requestId: requestId() }); session = await practice.getSession(owner, session.id);
  await practice.command(owner, session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'submit' }); const coach = await practice.claimJob('fixture-worker');
  if (failCoach) await practice.failJob(coach!, 'PRIVATE-PROVIDER-ERROR-FIXTURE', 0);
  else {
    const frozen = (await practice.exportSession(owner, session.id)).frozenEvidence!;
    await practice.completeJob(coach!, { kind: 'coach', model: 'synthetic-fixture', promptVersion: 'fixture-v1', actualUsd: 0, report: { overview: 'PRIVATE-ORIGINAL-REPORT', rubric: [{ criterionId: 'correctness', level: 'Developing', feedback: 'The recorded check failed.', evidenceIds: [frozen.items.find(item => item.kind === 'test')!.id], confidence: 'low' }], nextPractice: [{ drillId: 'drill', reason: 'Check a boundary.' }] } });
  }
  return practice.getSession(owner, session.id);
}
export async function openCase(context: ReturnType<typeof harness>, sessionId: string, inspectionConsent = true, supportActionsConsent = true) {
  const session = await context.practice.getSession(owner, sessionId);
  return context.reviews.createCase(owner, sessionId, { requestId: requestId(), category: session.reports.length ? 'feedback' : 'technical', ...(session.reports.length ? { reportId: session.reports.at(-1)!.id } : {}), message: 'PRIVATE-LEARNER-DISPUTE', inspectionConsent, supportActionsConsent });
}
export async function correction(context: ReturnType<typeof harness>, sessionId: string): Promise<CoachOutput> {
  const frozen = (await context.practice.exportSession(owner, sessionId)).frozenEvidence!;
  return { overview: 'PRIVATE-UNPUBLISHED-CORRECTION', rubric: [{ criterionId: 'correctness', level: 'Developing', feedback: 'The final recorded check failed; verify the behavior with another case.', evidenceIds: [frozen.items.find(item => item.kind === 'test')!.id], confidence: 'medium' }], nextPractice: [{ drillId: 'drill', reason: 'Check a boundary.' }] };
}
