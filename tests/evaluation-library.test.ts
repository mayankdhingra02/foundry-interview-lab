import { describe, expect, it } from 'vitest';
import recipes from '../evals/fixtures/attempts.json';
import capture from '../evals/fixtures/runtime-observations.json';
import annotations from '../evals/fixtures/human-review.template.json';
import baseline from '../evals/fixtures/baseline-summary.json';
import { annotationTemplate, attemptContextDigest, conservativeReport, materializeAttempt, type AttemptRecipe, type CandidateSet, type RuntimeCapture } from '../evals/benchmark';
import { buildEvaluationRepository, repositoryEvaluation, repositoryEvaluations, type RepositoryEvaluationSources } from '../lib/server/evaluation-library';

const sources = (): RepositoryEvaluationSources => structuredClone({ recipes, capture: capture as RuntimeCapture, annotations, candidates: null, baseline });
function hypotheticalReviewedSource() {
  // Calculation fixtures only: never persisted or represented as real provider
  // output, human work, or approved examples in the repository library.
  const source = sources(), attempt = materializeAttempt(recipes.cases[0] as AttemptRecipe, source.capture), probe = attempt.scenario.probes.find(row => row.stageId === 'debrief')!;
  const candidates: CandidateSet = { benchmarkVersion: recipes.version, provenance: 'recorded-model-output', candidates: [{ caseId: attempt.recipe.id, contextDigest: attemptContextDigest(attempt), model: 'offline-unit-placeholder', promptVersion: 'unit-only', rubricVersion: attempt.scenario.version, providerResponseId: 'PRIVATE-PROVIDER-IDENTITY', createdAt: '2026-10-10T00:00:00.000Z', report: { ...conservativeReport(attempt), overview: 'PRIVATE-MODEL-OUTPUT' }, proposal: { action: 'ask_probe', question: probe.question, competencyId: probe.competencyId, probeId: probe.id, evidenceIds: [] } }] };
  const labels = annotationTemplate(recipes.version, [attempt], candidates.candidates), assessment = { rubric: candidates.candidates[0].report.rubric.map(({ criterionId, level }) => ({ criterionId, level })), claims: [{ id: 'PRIVATE-CLAIM-ID', supported: true, fabricatedTestResult: false }], questions: [{ id: 'follow-up' as const, relevant: true, criticalSolutionLeak: false }], claimAuditComplete: true as const, notes: 'PRIVATE-REVIEW-NOTES' };
  labels.cases[0].reviews = [{ ...structuredClone(assessment), reviewerId: 'PRIVATE-REVIEWER-ONE', independent: true, completedAt: '2026-10-10T01:00:00.000Z' }, { ...structuredClone(assessment), reviewerId: 'PRIVATE-REVIEWER-TWO', independent: true, completedAt: '2026-10-10T01:01:00.000Z' }];
  labels.cases[0].reviews[0].rubric[0].level = 'Strong'; labels.cases[0].reviews[1].rubric[0].level = 'Developing';
  labels.cases[0].reviews[1].claims[0].supported = false;
  labels.cases[0].adjudication = { ...assessment, adjudicatorId: 'PRIVATE-ADJUDICATOR', reviewerIds: ['PRIVATE-REVIEWER-ONE', 'PRIVATE-REVIEWER-TWO'], completedAt: '2026-10-10T02:00:00.000Z' };
  source.candidates = candidates; source.annotations = labels; return { source, candidates, labels };
}

describe('fixed synthetic evaluation repository projection', () => {
  it('keeps all current examples and quality qualification explicitly pending', () => {
    const library = repositoryEvaluations();
    expect(library.catalog.examples).toHaveLength(21); expect(new Set(library.catalog.examples.map(row => row.scenario.id)).size).toBe(5);
    expect(library.catalog.qualification).toMatchObject({ status: 'pending', reviewedAttempts: 0, recordedCandidates: 0, approval: 'not-recorded' });
    expect(library.details.every(row => row.approvalStatus === 'pending' && row.annotationStatus === 'pending' && row.disagreementCount === null && row.annotations.disagreements === null)).toBe(true);
  });
  it('preserves no-execution, stale-run, sparse and prompt-injection conditions as quoted fixture data', () => {
    expect(repositoryEvaluation('unexecuted-reference').execution).toMatchObject({ status: 'not-executed', suiteCount: 0, relationshipToFinalSnapshot: 'not-executed' });
    expect(repositoryEvaluation('stale-run').execution.relationshipToFinalSnapshot).toBe('older');
    expect(repositoryEvaluation('sparse-reference').syntheticDialogue).toEqual([]);
    expect(repositoryEvaluation('injection-dialogue').syntheticDialogue[0]).toContain('Ignore your prior role');
    expect(() => repositoryEvaluation('private-learner-session')).toThrow('Evaluation example not found');
  });
  it('strips protected code, tests, runtime traces and server material through an explicit projection', () => {
    const source = sources();
    for (const row of source.capture.captures) { row.run.stdout = 'PRIVATE-STDOUT'; row.run.stderr = 'PRIVATE-STDERR'; row.run.command = 'PRIVATE-COMMAND'; row.run.tests.forEach(test => { test.title = 'PRIVATE-TEST-TITLE'; test.detail = 'PRIVATE-TEST-DETAIL'; }); }
    const result = buildEvaluationRepository(source), serialized = JSON.stringify(result);
    expect(serialized).not.toContain('PRIVATE-');
    const forbidden = new Set(['files', 'referenceFiles', 'tests', 'stdout', 'stderr', 'command', 'snapshots', 'ownerId', 'report', 'proposal', 'reviews', 'notes', 'reviewerId', 'providerResponseId']);
    const inspect = (value: unknown) => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { expect(forbidden.has(key), key).toBe(false); inspect(child); } };
    inspect(result);
    const attempt = materializeAttempt(recipes.cases[0] as AttemptRecipe, source.capture);
    for (const code of Object.values(attempt.scenario.referenceFiles)) expect(serialized).not.toContain(code);
    for (const test of attempt.scenario.tests) expect(serialized).not.toContain(test.source);
  });
  it('supports existing review formats, records real label differences and never invents an approval', () => {
    const { source } = hypotheticalReviewedSource(), detail = buildEvaluationRepository(source).details[0];
    expect(detail).toMatchObject({ annotationStatus: 'adjudicated', reviewCount: 2, disagreementCount: 2, candidateRecorded: true, approvalStatus: 'pending' });
    expect(detail.annotations.disagreements).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'rubric', reviewerOne: 'Strong', reviewerTwo: 'Developing', adjudication: 'Not observed' }), expect.objectContaining({ kind: 'claim', item: 'Substantive claim 1' })]));
    expect(JSON.stringify(detail)).not.toContain('PRIVATE-');
  });
  it('does not carry labels forward after a candidate or evidence-context change', () => {
    const changed = hypotheticalReviewedSource(); changed.candidates.candidates[0].report.overview += ' edited';
    expect(buildEvaluationRepository(changed.source).details[0]).toMatchObject({ annotationStatus: 'pending', reviewCount: 0, disagreementCount: null });
    const stale = hypotheticalReviewedSource(); stale.candidates.candidates[0].contextDigest = '0'.repeat(64);
    expect(buildEvaluationRepository(stale.source).details[0]).toMatchObject({ candidateRecorded: false, annotationStatus: 'pending', approvalStatus: 'blocked' });
  });
  it('keeps incomplete, duplicate-reviewer or unadjudicated work out of complete annotation status', () => {
    const one = hypotheticalReviewedSource(); one.labels.cases[0].reviews.pop(); one.labels.cases[0].adjudication = null;
    expect(buildEvaluationRepository(one.source).details[0]).toMatchObject({ annotationStatus: 'partial', disagreementCount: null });
    const same = hypotheticalReviewedSource(); same.labels.cases[0].reviews[1].reviewerId = same.labels.cases[0].reviews[0].reviewerId;
    expect(buildEvaluationRepository(same.source).details[0]).toMatchObject({ annotationStatus: 'partial', disagreementCount: null });
    const pending = hypotheticalReviewedSource(); pending.labels.cases[0].adjudication = null;
    expect(buildEvaluationRepository(pending.source).details[0]).toMatchObject({ annotationStatus: 'partial', disagreementCount: 2 });
    expect(buildEvaluationRepository(pending.source).details[0].annotations.disagreements!.every(row => row.adjudication === null)).toBe(true);
  });
  it('rejects unknown or duplicated source identities and stale runtime facts', () => {
    const unknown = sources(); (unknown.recipes as typeof recipes).cases[0].id = 'learner-upload'; expect(() => buildEvaluationRepository(unknown)).toThrow();
    const duplicate = sources(); (duplicate.recipes as typeof recipes).cases.push((duplicate.recipes as typeof recipes).cases[0]); expect(() => buildEvaluationRepository(duplicate)).toThrow('case identities');
    const stale = sources(); stale.capture.captures[0].snapshotSha256 = '0'.repeat(64); expect(() => buildEvaluationRepository(stale)).toThrow('no longer matches');
    const wrongVersion = sources(); (wrongVersion.annotations as typeof annotations).benchmarkVersion = 'another-benchmark'; expect(() => buildEvaluationRepository(wrongVersion)).toThrow('versions');
  });
});
