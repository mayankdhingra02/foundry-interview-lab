import { z } from 'zod';
import { DomainError, digest, selectedSnapshot, textDigest } from './domain';
import { LEARNER_CHECK_POLICY } from './check-policy';
import type { CoachOutput, EvidenceItem, EvidenceManifest, InterviewProposal, Scenario, Session } from './types';

export function buildEvidence(session: Session): EvidenceItem[] {
  const items: EvidenceItem[] = [], snapshot = selectedSnapshot(session);
  const add = (item: Omit<EvidenceItem, 'sha256'>) => items.push({ ...item, sha256: textDigest(item.content) });
  for (const [file, content] of Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b))) add({ id: `snapshot:${snapshot.id}:${file}`, kind: 'snapshot', label: `Code · ${file}`, file, snapshotId: snapshot.id, content, source: 'learner-workspace' });
  for (const run of session.runs) for (const test of run.tests) add({ id: `test:${run.id}:${test.id}`, kind: 'test', label: `${run.learnerCheck ? 'Learner check · ' : ''}${test.title} · ${test.status}`, content: JSON.stringify({ status: test.status, detail: test.detail ?? '', snapshotId: run.snapshotId, snapshotSha256: run.snapshotSha256, testSuiteDigest: run.testSuiteDigest, runtimeDigest: run.runtimeDigest ?? null, command: run.command, runStatus: run.status, ...(run.learnerCheck ? { learnerCheck: run.learnerCheck } : {}) }), snapshotId: run.snapshotId, testId: test.id, runId: run.id, source: run.learnerCheck ? 'learner-authored-check' : 'executed-test' });
  for (const turn of session.turns) add({ id: `turn:${turn.id}`, kind: 'utterance', label: `${turn.role} · ${turn.source}`, content: turn.text, turnId: turn.id, source: turn.source });
  for (const message of session.assistantMessages) add({ id: `assistant:${message.id}`, kind: 'assistant', label: `${message.role} · coding assistant`, content: message.text, source: message.role });
  for (const proposal of session.editProposals.filter(p => p.status !== 'pending')) add({ id: `edit:${proposal.id}`, kind: 'edit-decision', label: `AI edit ${proposal.status}${proposal.undoneAt ? ', later undone' : ''}`, content: JSON.stringify({ status: proposal.status, baseSnapshotId: proposal.baseSnapshotId, paths: Object.keys(proposal.files), files: proposal.files, ...(proposal.undoneAt ? { undoneAt: proposal.undoneAt, undoSnapshotId: proposal.undoSnapshotId } : {}) }), snapshotId: proposal.baseSnapshotId, source: 'recorded-decision' });
  return items;
}
export function freezeEvidence(session: Session, now: string): EvidenceManifest {
  const items = buildEvidence(session);
  return { digest: digest(items), watermark: session.events.length, items, frozenAt: now };
}
const finding = z.object({ criterionId: z.string().min(1).max(100), level: z.enum(['Strong', 'Developing', 'Needs work', 'Not observed']), feedback: z.string().min(1).max(1600), evidenceIds: z.array(z.string().max(250)).max(12), confidence: z.enum(['low', 'medium', 'high']) }).strict();
export const coachOutputSchema = z.object({ overview: z.string().min(1).max(3000), rubric: z.array(finding).min(1).max(20), nextPractice: z.array(z.object({ drillId: z.string().max(100), reason: z.string().min(1).max(600) }).strict()).min(1).max(3) }).strict();
// Deliberately narrow factual guard. Valid IDs and these phrase checks do NOT establish semantic truth.
export function validateExecutedTestClaims(output: CoachOutput, scenario: Scenario, manifest: EvidenceManifest) {
  const snapshotIds = new Set(manifest.items.filter(e => e.kind === 'snapshot').map(e => e.snapshotId));
  const testEvidence = manifest.items.filter(e => e.kind === 'test' && snapshotIds.has(e.snapshotId));
  const latest = (source: string) => {
    const selected = testEvidence.filter(e => e.source === source), lastRunId = selected.at(-1)?.runId;
    return selected.filter(e => e.runId === lastRunId).map(e => {
      try { return { testId: e.testId, ...(JSON.parse(e.content) as { status: string; runStatus: string }) }; }
      catch { throw new DomainError('invalid', 'Recorded test evidence is malformed.'); }
    });
  };
  const authored = latest('executed-test'), learner = latest('learner-authored-check');
  const matches = (observations: typeof authored, ids: string[], wanted: string) => ids.length > 0 && observations.length === ids.length && new Set(observations.map(t => t.testId)).size === ids.length && observations.every(t => ids.includes(t.testId ?? '') && t.status === wanted && t.runStatus === 'completed');
  const text = [output.overview, ...output.rubric.map(r => r.feedback), ...output.nextPractice.map(n => n.reason)].join('\n');
  const universalClaim = /\b(?:all|every)\s+(?:(recorded|executed|submitted|final|authored|protected|scenario|learner(?:[- ]authored)?)\s+)?(?:tests?|checks?)\s+(?:have\s+)?(passed|pass|failed|fail)\b/gi;
  for (const match of text.matchAll(universalClaim)) {
    const before = text.slice(Math.max(0, match.index! - 8), match.index);
    if (/\bnot\s+$/i.test(before)) continue;
    const qualifier = (match[1] ?? '').toLowerCase(), wanted = /^pass/i.test(match[2]) ? 'passed' : 'failed';
    const authorIds = scenario.tests.filter(test => qualifier !== 'protected' || !test.visible).map(test => test.id);
    const authoredMatches = matches(qualifier === 'protected' ? authored.filter(t => authorIds.includes(t.testId ?? '')) : authored, authorIds, wanted);
    const learnerMatches = matches(learner, [LEARNER_CHECK_POLICY.testId], wanted);
    const supported = qualifier.startsWith('learner') ? learnerMatches
      : ['authored','protected','scenario'].includes(qualifier) ? authoredMatches
      : authoredMatches && (!learner.length || learnerMatches);
    if (!supported) throw new DomainError('invalid', `Coaching claims all tests ${wanted}, but the final snapshot evidence does not support that claim.`);
  }
  // Even without an "all" quantifier, an authored/protected outcome needs its
  // own complete same-snapshot run. This remains a narrow phrase guard, not a
  // general semantic truth checker.
  const contractClaim = /\b(authored|protected|scenario)\s+(?:tests?|checks?|suite|contracts?)\s+(?:(?:have|has|now|all|are|is|were)\s+){0,3}(passed|passes|passing|pass|failed|fails|failing|fail)\b/gi;
  for (const match of text.matchAll(contractClaim)) {
    if (/\b(?:not|no|not all)\s+$/i.test(text.slice(Math.max(0,match.index! - 12),match.index))) continue;
    const ids = scenario.tests.filter(test => match[1].toLowerCase() !== 'protected' || !test.visible).map(test => test.id);
    const observations = authored.filter(test => ids.includes(test.testId ?? ''));
    if (!matches(observations,ids,/^pass/i.test(match[2]) ? 'passed' : 'failed')) throw new DomainError('invalid', 'Authored or protected contract claims require their own complete same-snapshot execution evidence.');
  }
}
export function validateReport(value: unknown, scenario: Scenario, manifest: EvidenceManifest): CoachOutput {
  const parsed = coachOutputSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('invalid', 'Coaching response did not match the report contract.');
  const output = parsed.data, criteria = new Set(scenario.rubric.map(c => c.id)), ids = new Set(manifest.items.map(e => e.id));
  if (output.rubric.length !== criteria.size || new Set(output.rubric.map(r => r.criterionId)).size !== criteria.size || output.rubric.some(r => !criteria.has(r.criterionId))) throw new DomainError('invalid', 'Report must cover each scenario criterion exactly once.');
  const explanations = manifest.items.some(e => e.kind === 'utterance' && ['typed', 'corrected', 'transcribed'].includes(e.source));
  const assistance = manifest.items.some(e => e.kind === 'assistant');
  for (const row of output.rubric) {
    if (new Set(row.evidenceIds).size !== row.evidenceIds.length || row.evidenceIds.some(id => !ids.has(id)) || (row.level !== 'Not observed' && !row.evidenceIds.length)) throw new DomainError('invalid', 'Report contains missing, unknown or duplicate evidence references.');
    if (!explanations && /comprehension|understand|communication/.test(row.criterionId) && row.level !== 'Not observed') throw new DomainError('invalid', 'Unrecorded explanations cannot be assessed.');
    if (!assistance && /ai[-_]?collaboration/.test(row.criterionId) && row.level !== 'Not observed') throw new DomainError('invalid', 'Optional AI use cannot be assessed when no interaction was recorded.');
  }
  if (output.nextPractice.some(next => !scenario.drills.some(d => d.id === next.drillId))) throw new DomainError('invalid', 'Report recommended an unknown drill.');
  validateExecutedTestClaims(output, scenario, manifest);
  return output;
}
export const interviewProposalSchema = z.object({ action: z.enum(['ask_probe', 'end_debrief']), question: z.string().min(1).max(1200).optional(), competencyId: z.string().max(100).optional(), evidenceIds: z.array(z.string().max(250)).max(8), probeId: z.string().max(100).optional() }).strict();
export function validateInterviewProposal(value: unknown, scenario: Scenario, session: Session): InterviewProposal {
  const parsed = interviewProposalSchema.safeParse(value);
  if (!parsed.success) throw new DomainError('invalid', 'Interviewer response did not match the question contract.');
  const proposal = parsed.data, ids = new Set(buildEvidence(session).map(e => e.id));
  if (proposal.evidenceIds.some(id => !ids.has(id))) throw new DomainError('invalid', 'Interviewer cited unknown evidence.');
  const asked = session.turns.filter(t => t.role === 'interviewer');
  const required = new Set(scenario.probes.filter(p => p.stageId === session.stageId).map(p => p.competencyId));
  const uncovered = [...required].filter(id => !asked.some(t => t.competencyId === id));
  if (proposal.action === 'end_debrief') {
    if (asked.length < 6 && uncovered.length) throw new DomainError('conflict', 'Required debrief coverage remains.');
    return proposal;
  }
  if (!proposal.question || !scenario.rubric.some(r => r.id === proposal.competencyId)) throw new DomainError('invalid', 'Question must target an allowed competency.');
  if (proposal.probeId && !scenario.probes.some(p => p.id === proposal.probeId && p.competencyId === proposal.competencyId && p.stageId === session.stageId)) throw new DomainError('invalid', 'Question uses a probe outside the current stage.');
  if (session.turns.filter(t => t.role === 'interviewer' && t.competencyId === proposal.competencyId).length >= 3) throw new DomainError('conflict', 'This competency has reached its question limit.');
  if (asked.length >= 6) throw new DomainError('conflict', 'This debrief has reached its question limit.');
  if (6 - asked.length <= uncovered.length && !uncovered.includes(proposal.competencyId!)) throw new DomainError('conflict', 'This question must cover an unobserved required competency.');
  return proposal;
}
