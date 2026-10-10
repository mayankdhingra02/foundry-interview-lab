// Hypothetical unit fixtures only: no provider, real learner or expert review.
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import { authoredQuestion, PROMPT_VERSION } from '../lib/ai/provider';
import { inferenceBindingDigest } from '../lib/ai/binding';
import type { CoachOutput } from '../lib/interview-practice/types';
import type { PrivateCorpus } from '../evals/private-corpus';
import type { PrivateRoleExecutor, PrivateRoleRun } from '../evals/private-role-runner';
import type { RoleAssessment } from '../evals/role-review';
import { fixtureRuntimeBinding } from './runtime-fixtures';
export const unitRecordedAt = '2026-10-09T13:00:00.000Z';
export function unitPrivateCorpus(split: PrivateCorpus['corpus']['split'] = 'acceptance'): PrivateCorpus {
  const scenario = getScenario('monetary-validation')!, files = structuredClone(scenario.files); files[Object.keys(files)[0]] += '\n# HYPOTHETICAL PRIVATE ROLE UNIT CASE\n';
  return { schemaVersion: 1, corpus: { id: 'hypothetical-private-unit', version: '1.0.0', split }, provenance: 'operator-supplied-private-corpus', createdAt: '2026-10-09T12:00:00.000Z', independence: { sealedFromPromptDevelopment: true, custodianId: 'unit-source-custodian' }, cases: [{ id: 'hypothetical-case', scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), rubricVersion: scenario.version, rubricDigest: digest(scenario.rubric), fixtureVersion: '1.0.0', runtime: fixtureRuntimeBinding(scenario), source: { kind: 'operator-authored-synthetic', sourceId: 'unit-source', preparedBy: 'unit-preparer', preparedAt: '2026-10-09T12:00:00.000Z', usedForPromptDevelopment: false, dataPolicy: 'deidentified-no-credentials-no-raw-audio' }, condition: 'partial', snapshot: { version: '1.0.0', createdAt: '2026-10-09T11:15:00.000Z', files, sha256: digest(files) }, startedAt: '2026-10-09T11:00:00.000Z', endedAt: '2026-10-09T11:45:00.000Z', dialogue: [{ id: 'unit-explanation', role: 'learner', text: 'Hypothetical unit explanation, not a real learner.', source: 'typed', createdAt: '2026-10-09T11:40:00.000Z' }], assistantMessages: [], execution: { kind: 'unexecuted' }, conditions: { mode: 'simulation', promptExposure: 'fresh', role: 'Backend engineer', level: scenario.level, skills: scenario.tags, targetMinutes: 45, originalTargetMinutes: 45, extensions: [], aiHelp: true, hintsOpened: 0, practiceConditions: { timing: 'standard', participation: 'written-only' } }, reviewFocus: ['Unit-only provenance and review boundary.'] }] };
}
export const unitPrivateExecutor: PrivateRoleExecutor = async task => {
  const common = { model: 'unit-mocked-model', actualUsd: 0.00165, inference: { requestedModel: 'gpt-5.4-mini', returnedModel: 'unit-mocked-model', promptVersion: PROMPT_VERSION, responseId: 'hypothetical-not-a-provider-response', inputTokens: 1000, outputTokens: 200, startedAt: '2026-10-09T13:00:01.000Z', completedAt: '2026-10-09T13:00:02.000Z', usd: 0.00165, validated: true, provider: task.inferenceBinding.provider, role: task.inferenceBinding.role, schemaVersion: task.inferenceBinding.schemaVersion, contextVersion: task.inferenceBinding.contextVersion, bindingDigest: inferenceBindingDigest(task.inferenceBinding) } };
  if (task.role === 'interviewer') return { kind: 'interviewer', proposal: authoredQuestion(task.attempt.scenario, task.session), ...common };
  if (task.role === 'coach') {
    const report: CoachOutput = { overview: 'Hypothetical unit output; no live model or expert assessment.', rubric: task.attempt.scenario.rubric.map(criterion => ({ criterionId: criterion.id, level: 'Not observed', feedback: 'No verified skill assessment in this unit fixture.', evidenceIds: [], confidence: 'low' })), nextPractice: [{ drillId: task.attempt.scenario.drills[0].id, reason: 'Original authored drill, no weakness inferred.' }] };
    const criterion = report.rubric.find(row => !/comprehension|understand|communication|ai[-_]?collaboration/.test(row.criterionId))!;
    criterion.level = 'Developing'; criterion.evidenceIds = [task.attempt.session.frozenEvidence!.items[0].id];
    return { kind: 'coach', report, promptVersion: PROMPT_VERSION, ...common };
  }
  return { kind: 'assistant', message: 'Hypothetical unit candidate; no external provider contacted.', files: {}, ...common };
};
export const unitPrivateOptions = () => ({ enabled: true, acknowledgePaidApi: true, maxUsd: 1, operatorId: 'unit-model-operator', executor: unitPrivateExecutor, now: () => new Date(unitRecordedAt), persist: async (_run: PrivateRoleRun) => { void _run; } });
export function unitPrivateLabels(entry: PrivateRoleRun['entries'][number]): RoleAssessment {
  const common = { claimAuditComplete: true, noSubstantiveClaims: false, claims: [{ id: 'claim-1', support: 'supported' as const, fabricatedExecution: false, criticalSolutionLeak: false }], fabricatedExecution: false, criticalSolutionLeak: false, notes: 'Hypothetical unit labels; not actual human annotations.' };
  if (entry.output!.kind === 'coach') return { kind: 'coach', ...common, rubric: entry.output!.report.rubric.map(({ criterionId, level }) => ({ criterionId, level })) };
  if (entry.role === 'interviewer') return { kind: 'interviewer', ...common, relevance: 'pass', policyCompliance: 'pass' };
  return { kind: 'assistant', ...common, mode: entry.role.slice('assistant-'.length) as 'ask' | 'plan' | 'edit', usefulness: 'pass', requestCompliance: 'pass', policyCompliance: 'pass', correctness: 'pass', correctnessBasis: 'static-review' };
}
