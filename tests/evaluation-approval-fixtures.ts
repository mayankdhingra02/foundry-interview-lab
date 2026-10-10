// Hypothetical test calculations only. No provider call, expert work, real
// approval or learner data is represented by these in-memory artifacts.
import recipes from '../evals/fixtures/attempts.json';
import capture from '../evals/fixtures/runtime-observations.json';
import blankAnnotations from '../evals/fixtures/human-review.template.json';
import baseline from '../evals/fixtures/baseline-summary.json';
import { annotationTemplate, attemptContextDigest, conservativeReport, materializeAttempt, type AttemptRecipe, type CandidateSet, type RuntimeCapture } from '../evals/benchmark';
import { digest } from '../lib/interview-practice/domain';
import { evaluationApprovalBinding, type EvaluationReviewBundle, type ReviewImport } from '../lib/server/evaluation-approval';
import type { RepositoryEvaluationSources } from '../lib/server/evaluation-library';

export const reviewNow = Date.parse('2026-10-12T00:00:00.000Z');
export const reviewerIds = ['test-reviewer-one', 'test-reviewer-two', 'test-adjudicator', 'test-approver'];
export function hypotheticalApproval() {
  const source: RepositoryEvaluationSources = structuredClone({ recipes, capture: capture as RuntimeCapture, annotations: blankAnnotations, candidates: null, baseline });
  const attempt = materializeAttempt(recipes.cases[0] as AttemptRecipe, source.capture), probe = attempt.scenario.probes.find(row => row.stageId === 'debrief')!;
  const candidates: CandidateSet = { benchmarkVersion: recipes.version, provenance: 'recorded-model-output', candidates: [{ caseId: attempt.recipe.id, contextDigest: attemptContextDigest(attempt), model: 'unit-placeholder-only', promptVersion: 'unit-only', rubricVersion: attempt.scenario.version, providerResponseId: 'PRIVATE-PROVIDER-ID', createdAt: '2026-10-10T00:00:00.000Z', report: { ...conservativeReport(attempt), overview: 'HYPOTHETICAL-DISPLAY-OUTPUT <script>window.exampleInjected=true</script>' }, proposal: { action: 'ask_probe', question: probe.question, competencyId: probe.competencyId, probeId: probe.id, evidenceIds: [] } }] };
  candidates.candidates[0].report.rubric[0].evidenceIds = [attempt.session.frozenEvidence!.items[0].id];
  const annotations = annotationTemplate(recipes.version, [attempt], candidates.candidates), assessment = { rubric: candidates.candidates[0].report.rubric.map(({ criterionId, level }) => ({ criterionId, level })), claims: [{ id: 'PRIVATE-CLAIM-ID', supported: true, fabricatedTestResult: false }], questions: [{ id: 'follow-up' as const, relevant: true, criticalSolutionLeak: false }], claimAuditComplete: true as const, notes: 'PRIVATE-HUMAN-NOTES' };
  annotations.cases[0].reviews = reviewerIds.slice(0, 2).map((reviewerId, index) => ({ ...structuredClone(assessment), reviewerId, independent: true, completedAt: `2026-10-10T01:0${index}:00.000Z` }));
  annotations.cases[0].adjudication = { ...structuredClone(assessment), adjudicatorId: reviewerIds[2], reviewerIds: reviewerIds.slice(0, 2), completedAt: '2026-10-10T02:00:00.000Z' };
  const bundle: EvaluationReviewBundle = { schemaVersion: 1, scope: 'fixed-synthetic-staff-display', benchmarkVersion: recipes.version, recipesDigest: digest(source.recipes), captureDigest: digest(source.capture), baselineDigest: digest(source.baseline), candidates, annotations, approvals: [] };
  bundle.approvals.push({ binding: evaluationApprovalBinding(recipes.version, attempt, candidates.candidates[0], annotations.cases[0], { candidates, annotations }), decision: 'approved', decidedBy: reviewerIds[3], decidedAt: '2026-10-11T00:00:00.000Z', expiresAt: '2026-11-11T00:00:00.000Z', scope: 'fixed-synthetic-staff-display', attestations: { syntheticOnly: true, contentQualityReviewed: true, privacyReviewed: true, displayApproved: true } });
  const review: ReviewImport = { bundle, authorizedReviewerIds: new Set(reviewerIds), artifactDigest: 'e'.repeat(64), now: reviewNow };
  source.candidates = candidates; source.annotations = annotations; source.review = review;
  return { source, review, bundle, attempt, candidates, annotations };
}
