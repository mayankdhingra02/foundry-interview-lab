import 'server-only';
import { z } from 'zod';
import recipesFile from '../../evals/fixtures/attempts.json';
import captureFile from '../../evals/fixtures/runtime-observations.json';
import annotationsFile from '../../evals/fixtures/human-review.template.json';
import baselineFile from '../../evals/fixtures/baseline-summary.json';
import { annotationSchema, attemptContextDigest, attemptRecipeSchema, calculateReleaseGate, candidateDigest, candidateSetSchema, materializeAttempt, type AttemptRecipe, type RuntimeCapture } from '../../evals/benchmark';
import { HttpError } from './http';

// Explicitly curated developer fixtures. New repository cases require a source
// and privacy review before being added; this is not a claim of expert approval.
const CASE_IDS = ['money-reference', 'money-starter', 'compatibility-reference', 'compatibility-starter', 'invoice-reference', 'invoice-starter', 'inventory-reference', 'inventory-starter', 'rollup-reference', 'rollup-starter', 'sparse-reference', 'confident-wrong', 'injection-dialogue', 'unexecuted-reference', 'stale-run', 'rejected-correct-edit', 'accepted-bad-edit', 'money-partial-rounding', 'compatibility-alternative-unexecuted', 'inventory-interrupted-before-run', 'rollup-interrupted-during-run'] as const;
const recipeSchema = attemptRecipeSchema.extend({ id: z.enum(CASE_IDS) });
const sourceSchema = z.object({ version: z.string().min(1).max(100), provenance: z.string().max(1000), cases: z.array(recipeSchema).min(1).max(60) }).strict();
type Label = { rubric: { criterionId: string; level: string }[]; claims: { id: string; supported: boolean; fabricatedTestResult: boolean }[]; questions: { id: string; relevant: boolean; criticalSolutionLeak: boolean }[] };
export type EvaluationDisagreement = { kind: 'rubric' | 'claim' | 'question'; item: string; reviewerOne: string; reviewerTwo: string; adjudication: string | null };
export type EvaluationExampleSummary = {
  id: string; scenario: { id: string; title: string; version: string }; variant: AttemptRecipe['variant']; condition: string;
  provenance: 'developer-authored-synthetic'; annotationStatus: 'pending' | 'partial' | 'adjudicated'; approvalStatus: 'pending' | 'blocked';
  reviewCount: number; disagreementCount: number | null; candidateRecorded: boolean;
};
export type EvaluationExample = EvaluationExampleSummary & {
  source: { benchmarkVersion: string; provenance: string; fixturePath: string; contextDigest: string; snapshotVersion?: string; snapshotSha256?: string; fixtureDigest?: string };
  brief: { summary: string; stages: { title: string; brief: string; requirements: string[] }[]; rubric: { id: string; name: string; description: string; anchors: { strong: string; developing: string; needsWork: string } }[] };
  syntheticDialogue: string[]; reviewFocus: string[];
  execution: { status: string; relationshipToFinalSnapshot: 'same' | 'older' | 'not-executed'; recordedAt: string | null; runtimeDigest: string | null; suiteCount: number; passedSuites: number; failedSuites: number; unresolvedSuites: number; provenance: string };
  annotations: { status: EvaluationExampleSummary['annotationStatus']; reason: string; adjudicationRecorded: boolean; adjudicatedAt: string | null; disagreements: EvaluationDisagreement[] | null };
  candidate: { digest: string; model: string; promptVersion: string; rubricVersion: string; createdAt: string } | null;
};
export type EvaluationLibrary = {
  benchmarkVersion: string; provenance: string; sourcePolicy: string; examples: EvaluationExampleSummary[];
  qualification: { status: 'pending' | 'blocked' | 'passed'; reviewedAttempts: number; totalAttempts: number; recordedCandidates: number; pendingReasons: string[]; blockingReasons: string[]; baselineRecordedAt: string; approval: 'not-recorded' };
};
export type RepositoryEvaluationSources = { recipes: unknown; capture: RuntimeCapture; annotations: unknown; candidates: unknown | null; baseline: { generatedAt: string; regressions: { id: string; passed: boolean; detail: string }[] } };

function disagreements(first: Label, second: Label, resolved: Label | null, criteria: { id: string; name: string }[]): EvaluationDisagreement[] {
  const rows: EvaluationDisagreement[] = [];
  for (const criterion of criteria) {
    const a = first.rubric.find(row => row.criterionId === criterion.id)?.level ?? 'Not labeled', b = second.rubric.find(row => row.criterionId === criterion.id)?.level ?? 'Not labeled';
    if (a !== b) rows.push({ kind: 'rubric', item: criterion.name, reviewerOne: a, reviewerTwo: b, adjudication: resolved?.rubric.find(row => row.criterionId === criterion.id)?.level ?? null });
  }
  const claims = [...new Set([...first.claims, ...second.claims].map(row => row.id))];
  const claimLabel = (row?: Label['claims'][number]) => row ? `${row.supported ? 'Supported' : 'Unsupported'}; ${row.fabricatedTestResult ? 'fabricated test result' : 'no fabricated test result flagged'}` : 'Not labeled';
  for (const [index, id] of claims.entries()) {
    const a = claimLabel(first.claims.find(row => row.id === id)), b = claimLabel(second.claims.find(row => row.id === id));
    if (a !== b) rows.push({ kind: 'claim', item: `Substantive claim ${index + 1}`, reviewerOne: a, reviewerTwo: b, adjudication: resolved ? claimLabel(resolved.claims.find(row => row.id === id)) : null });
  }
  const questionLabel = (row?: Label['questions'][number]) => row ? `${row.relevant ? 'Relevant' : 'Not relevant'}; ${row.criticalSolutionLeak ? 'critical solution leak' : 'no critical solution leak flagged'}` : 'Not labeled';
  const a = questionLabel(first.questions[0]), b = questionLabel(second.questions[0]);
  if (a !== b) rows.push({ kind: 'question', item: 'Follow-up question', reviewerOne: a, reviewerTwo: b, adjudication: resolved ? questionLabel(resolved.questions[0]) : null });
  return rows;
}

/** Fixed repository sources only. No PracticeStore, learner export or upload path. */
export function buildEvaluationRepository(sources: RepositoryEvaluationSources): { catalog: EvaluationLibrary; details: EvaluationExample[] } {
  const recipes = sourceSchema.parse(sources.recipes), annotations = annotationSchema.parse(sources.annotations), candidates = sources.candidates === null ? null : candidateSetSchema.parse(sources.candidates);
  if (new Set(recipes.cases.map(row => row.id)).size !== recipes.cases.length) throw new Error('Invalid repository evaluation case identities.');
  if (annotations.benchmarkVersion !== recipes.version || (candidates && candidates.benchmarkVersion !== recipes.version)) throw new Error('Invalid repository evaluation versions.');
  for (const rows of [annotations.cases, candidates?.candidates ?? []]) if (new Set(rows.map(row => row.caseId)).size !== rows.length || rows.some(row => !recipes.cases.some(recipe => recipe.id === row.caseId))) throw new Error('Invalid repository evaluation case identities.');
  const attempts = recipes.cases.map(recipe => materializeAttempt(recipe as AttemptRecipe, sources.capture));
  const gate = calculateReleaseGate(recipes.version, attempts, sources.baseline.regressions, candidates, annotations);
  const details: EvaluationExample[] = attempts.map(attempt => {
    const { recipe, scenario, session } = attempt, candidate = candidates?.candidates.find(row => row.caseId === recipe.id), annotation = annotations.cases.find(row => row.caseId === recipe.id);
    const scoped = calculateReleaseGate(recipes.version, [attempt], sources.baseline.regressions, candidate ? { ...candidates!, candidates: [candidate] } : null, { ...annotations, cases: annotation ? [annotation] : [] });
    const candidateBound = Boolean(candidate && candidate.contextDigest === attemptContextDigest(attempt) && !scoped.blockingReasons.some(reason => reason.startsWith('Candidate ')));
    const reviewBound = Boolean(candidateBound && annotation?.candidateDigest === candidateDigest(candidate!));
    const reviews = reviewBound ? annotation!.reviews : [], adjudicated = scoped.metrics.reviewedAttempts === 1;
    const distinctPair = reviews.length === 2 && new Set(reviews.map(row => row.reviewerId.trim().toLowerCase())).size === 2;
    const status = adjudicated ? 'adjudicated' as const : reviews.length ? 'partial' as const : 'pending' as const;
    const knownDisagreements = distinctPair ? disagreements(reviews[0], reviews[1], adjudicated ? annotation!.adjudication : null, scenario.rubric) : null;
    const run = session.runs[0], finalSnapshot = session.snapshots.at(-1)!;
    return {
      id: recipe.id, scenario: { id: scenario.id, title: scenario.title, version: scenario.version }, variant: recipe.variant, condition: recipe.condition, provenance: 'developer-authored-synthetic', annotationStatus: status,
      // Annotation completion is not an approval decision. The current artifact
      // format has no explicit example-approval field; never invent one.
      approvalStatus: scoped.blockingReasons.some(reason => /fabricated|solution leak|below|Candidate /.test(reason)) ? 'blocked' : 'pending', reviewCount: reviews.length, disagreementCount: knownDisagreements?.length ?? null, candidateRecorded: candidateBound,
      source: { benchmarkVersion: recipes.version, provenance: recipes.provenance, fixturePath: 'evals/fixtures/attempts.json', contextDigest: attemptContextDigest(attempt), snapshotVersion: attempt.fixtureIdentity.version, snapshotSha256: attempt.fixtureIdentity.snapshotSha256, fixtureDigest: attempt.fixtureIdentity.digest },
      brief: { summary: scenario.summary, stages: scenario.stages.map(({ title, brief, requirements }) => ({ title, brief, requirements: [...requirements] })), rubric: scenario.rubric.map(({ id, name, description, anchors }) => ({ id, name, description, anchors: { ...anchors } })) },
      syntheticDialogue: [...recipe.answers], reviewFocus: [...recipe.reviewFocus],
      execution: { status: run?.status ?? (attempt.executionContext.kind === 'interrupted' ? 'interrupted' : 'not-executed'), relationshipToFinalSnapshot: !run ? 'not-executed' : run.snapshotSha256 === finalSnapshot.sha256 ? 'same' : 'older', recordedAt: run?.createdAt ?? null, runtimeDigest: run?.runtimeDigest ?? null, suiteCount: run?.tests.length ?? 0, passedSuites: run?.tests.filter(row => row.status === 'passed').length ?? 0, failedSuites: run?.tests.filter(row => ['failed', 'error'].includes(row.status)).length ?? 0, unresolvedSuites: run?.tests.filter(row => row.status === 'skipped').length ?? 0, provenance: run ? 'Actual captured isolated Docker observations; synthetic attempt and dialogue.' : attempt.executionContext.interruption ? `Developer-authored interruption state: ${attempt.executionContext.interruption.reason}, ${attempt.executionContext.interruption.phase}. No execution or timeout experiment was performed; no test result is recorded.` : 'No checks executed for this synthetic attempt.' },
      annotations: { status, reason: adjudicated ? 'Two distinct independent-review attestations and matching adjudication are recorded. Reviewer identity, independence and example approval still require the human review process.' : reviews.length ? 'Bound review labels are recorded, but the required independent pair and valid adjudication are incomplete.' : 'No validated model candidate with bound independent human reviews is recorded. Expert labels and disagreements remain unknown.', adjudicationRecorded: adjudicated, adjudicatedAt: adjudicated ? annotation!.adjudication!.completedAt : null, disagreements: knownDisagreements },
      candidate: candidateBound ? { digest: candidateDigest(candidate!), model: candidate!.model, promptVersion: candidate!.promptVersion, rubricVersion: candidate!.rubricVersion, createdAt: candidate!.createdAt } : null,
    };
  });
  const examples = details.map(({ id, scenario, variant, condition, provenance, annotationStatus, approvalStatus, reviewCount, disagreementCount, candidateRecorded }) => ({ id, scenario, variant, condition, provenance, annotationStatus, approvalStatus, reviewCount, disagreementCount, candidateRecorded }));
  return { catalog: { benchmarkVersion: recipes.version, provenance: recipes.provenance, sourcePolicy: 'Fixed developer-authored synthetic repository fixtures only. No learner attempts, support records or uploads are read. Human approval is not recorded by the current annotation format.', examples, qualification: { status: gate.status, reviewedAttempts: gate.metrics.reviewedAttempts, totalAttempts: attempts.length, recordedCandidates: details.filter(row => row.candidateRecorded).length, pendingReasons: gate.pendingReasons, blockingReasons: gate.blockingReasons, baselineRecordedAt: sources.baseline.generatedAt, approval: 'not-recorded' } }, details };
}

export function repositoryEvaluations() {
  return buildEvaluationRepository({ recipes: recipesFile, capture: captureFile as RuntimeCapture, annotations: annotationsFile, candidates: null, baseline: baselineFile });
}
export function repositoryEvaluation(id: string) {
  const detail = repositoryEvaluations().details.find(row => row.id === id);
  if (!detail) throw new HttpError(404, 'not_found', 'Evaluation example not found.');
  return detail;
}
