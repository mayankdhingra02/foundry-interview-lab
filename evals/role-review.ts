import { z } from 'zod';
import { digest, validateFiles } from '../lib/interview-practice/domain';
import { validateInterviewProposal, validateReport } from '../lib/interview-practice/evidence';
import type { RubricLevel } from '../lib/interview-practice/types';
import type { BenchmarkAttempt } from './benchmark';
import { createRoleContexts, EVALUATION_ROLES, validateRoleRun, type EvaluationRole, type RoleRun } from './role-runner';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().trim().min(1).max(100);
const verdict = z.enum(['pass', 'fail', 'not-observed']);
const commonLabels = {
  claimAuditComplete: z.boolean(), noSubstantiveClaims: z.boolean(),
  claims: z.array(z.object({ id: identifier, support: z.enum(['supported', 'unsupported', 'not-observed']), fabricatedExecution: z.boolean(), criticalSolutionLeak: z.boolean() }).strict()).max(200),
  fabricatedExecution: z.boolean().nullable(), criticalSolutionLeak: z.boolean().nullable(), notes: z.string().trim().min(1).max(6000),
};
export const roleAssessmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coach'), ...commonLabels, rubric: z.array(z.object({ criterionId: identifier, level: z.enum(['Strong', 'Developing', 'Needs work', 'Not observed']) }).strict()).max(50) }).strict(),
  z.object({ kind: z.literal('interviewer'), ...commonLabels, relevance: verdict, policyCompliance: verdict }).strict(),
  z.object({ kind: z.literal('assistant'), ...commonLabels, mode: z.enum(['ask', 'plan', 'edit']), usefulness: verdict, requestCompliance: verdict, policyCompliance: verdict, correctness: verdict, correctnessBasis: z.enum(['static-review', 'not-observed']) }).strict(),
]);
const reviewSchema = z.object({ reviewerId: identifier, independent: z.literal(true), completedAt: z.string().datetime(), labels: roleAssessmentSchema }).strict();
const adjudicationSchema = z.object({ adjudicatorId: identifier, reviewerIds: z.array(identifier).length(2), completedAt: z.string().datetime(), labels: roleAssessmentSchema }).strict();
const bindingShape = { caseId: identifier, role: z.enum(EVALUATION_ROLES), contextDigest: hash, scenarioId: identifier, scenarioVersion: identifier, scenarioDigest: hash, rubricVersion: identifier, evidenceDigest: hash, candidateDigest: hash };
export const roleAnnotationsSchema = z.object({
  version: z.literal(1), provenance: z.literal('human-review-required'), corpus: z.literal('development-regression'), runId: z.string().uuid(), runDigest: hash, benchmarkVersion: identifier, benchmarkDigest: hash, promptVersion: identifier,
  cases: z.array(z.object({ ...bindingShape, reviews: z.array(reviewSchema).max(2), adjudication: adjudicationSchema.nullable() }).strict()).max(300),
}).strict();
export type RoleAssessment = z.infer<typeof roleAssessmentSchema>;
export type RoleAnnotations = z.infer<typeof roleAnnotationsSchema>;
export type RoleReviewContext = { benchmarkVersion: string; attempts: BenchmarkAttempt[] };
export type QualityMetric = { numerator: number; denominator: number; value: number | null };
const metric = (): QualityMetric => ({ numerator: 0, denominator: 0, value: null });
const metricKeys = ['claimSupport', 'rubricWithinOneBand', 'relevance', 'policyCompliance', 'usefulness', 'requestCompliance', 'correctness'] as const;
type MetricKey = typeof metricKeys[number];
type RoleMetrics = Record<MetricKey, QualityMetric> & { unobservedRubricPairs: number; unsupportedObservedRatings: number };
type Coverage = { planned: number; attempted: number; validated: number; adjudicated: number; reviewed: number; pending: number; rejectedOrIncomplete: number };
const emptyCoverage = (): Coverage => ({ planned: 0, attempted: 0, validated: 0, adjudicated: 0, reviewed: 0, pending: 0, rejectedOrIncomplete: 0 });
const emptyMetrics = (): RoleMetrics => ({ ...Object.fromEntries(metricKeys.map(key => [key, metric()])) as Record<MetricKey, QualityMetric>, unobservedRubricPairs: 0, unsupportedObservedRatings: 0 });
const key = (row: { caseId: string; role: string }) => JSON.stringify([row.caseId, row.role]);
const normalized = (id: string) => id.trim().toLowerCase();
export const roleCandidateDigest = (entry: RoleRun['entries'][number]) => digest(entry);

/** Structural metadata and exact current authored contexts, never provider calls. */
function boundRun(value: unknown, context: RoleReviewContext) {
  const run = validateRoleRun(value);
  if (context.benchmarkVersion !== run.benchmarkVersion) throw new Error('Role review benchmark version does not match the authored corpus.');
  if (new Set(context.attempts.map(row => row.recipe.id)).size !== context.attempts.length) throw new Error('Authored attempt identities must be unique.');
  const attemptMap = new Map(context.attempts.map(row => [row.recipe.id, row]));
  const caseIds = [...new Set(run.planned.map(row => row.caseId))], roles = [...new Set(run.planned.map(row => row.role))];
  if (caseIds.some(id => !attemptMap.has(id))) throw new Error('The run includes an unknown authored attempt.');
  const plan = createRoleContexts(context.benchmarkVersion, caseIds.map(id => attemptMap.get(id)!), roles);
  const expected = new Map(plan.contexts.map(row => [key(row), row])), tasks = new Map(plan.tasks.map(task => [key({ caseId: task.attempt.recipe.id, role: task.role }), task]));
  if (run.planned.length !== expected.size) throw new Error('The run is missing a planned case/role context.');
  for (const row of run.planned) {
    const { reservedUsd: _reserved, ...actual } = row, wanted = expected.get(key(row))!;
    void _reserved;
    if (digest(actual) !== digest(wanted)) throw new Error('The recorded role context or scenario/rubric/evidence version changed.');
  }
  for (const entry of run.entries) {
    if (entry.state !== 'validated') continue;
    if (Date.parse(entry.inference!.startedAt) < Date.parse(run.createdAt)) throw new Error('Provider inference precedes the run journal.');
    const task = tasks.get(key(entry))!, output = entry.output!;
    if (output.kind === 'coach') validateReport(output.report, task.attempt.scenario, task.session.frozenEvidence!);
    else if (output.kind === 'interviewer') validateInterviewProposal(output.proposal, task.attempt.scenario, task.session);
    else {
      const paths = Object.keys(output.files);
      if (paths.some(path => !Object.hasOwn(task.session.files, path)) || (task.input!.mode !== 'edit' && paths.length)) throw new Error('Imported assistant output exceeds its request/file policy.');
      if (paths.length) validateFiles({ ...task.session.files, ...output.files }, task.attempt.scenario);
    }
  }
  return { run, attemptMap };
}
const binding = (run: RoleRun, entry: RoleRun['entries'][number]) => {
  const planned = run.planned.find(row => key(row) === key(entry))!;
  return { caseId: entry.caseId, role: entry.role, contextDigest: entry.contextDigest, scenarioId: planned.scenarioId, scenarioVersion: planned.scenarioVersion, scenarioDigest: planned.scenarioDigest, rubricVersion: planned.rubricVersion, evidenceDigest: planned.evidenceDigest, candidateDigest: roleCandidateDigest(entry) };
};

/** New role-specific format; intentionally separate from the legacy paired gate. */
export function roleAnnotationTemplate(value: unknown, context: RoleReviewContext): RoleAnnotations {
  const { run } = boundRun(value, context);
  return { version: 1, provenance: 'human-review-required', corpus: 'development-regression', runId: run.runId, runDigest: digest(run), benchmarkVersion: run.benchmarkVersion, benchmarkDigest: run.benchmarkDigest, promptVersion: run.promptVersion, cases: run.entries.filter(entry => entry.state === 'validated').map(entry => ({ ...binding(run, entry), reviews: [], adjudication: null })) };
}

function assessmentPending(labels: RoleAssessment, role: EvaluationRole, attempt: BenchmarkAttempt): string[] {
  const expectedKind = role.startsWith('assistant-') ? 'assistant' : role;
  if (labels.kind !== expectedKind || (labels.kind === 'assistant' && `assistant-${labels.mode}` !== role)) throw new Error('Review labels belong to another role or assistant mode.');
  const claimIds = labels.claims.map(row => row.id);
  if (new Set(claimIds).size !== claimIds.length) throw new Error('Claim labels must have unique identities.');
  if (labels.noSubstantiveClaims && labels.claims.length) throw new Error('A no-claims attestation cannot contain audited claims.');
  const reasons: string[] = [];
  if (!labels.claimAuditComplete || (!labels.noSubstantiveClaims && !labels.claims.length)) reasons.push('Substantive-claim audit is incomplete.');
  if (labels.claims.some(row => row.support === 'not-observed')) reasons.push('Claim support has missing observations.');
  if (labels.fabricatedExecution === null || labels.criticalSolutionLeak === null) reasons.push('Critical safety labels are missing.');
  if (labels.kind === 'coach') {
    const expected = attempt.scenario.rubric.map(row => row.id), actual = labels.rubric.map(row => row.criterionId);
    if (new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) throw new Error('Coach labels contain duplicated or unknown rubric criteria.');
    if (actual.length !== expected.length) reasons.push('Coach rubric coverage is incomplete.');
  } else {
    const fields = labels.kind === 'interviewer' ? [labels.relevance, labels.policyCompliance] : [labels.usefulness, labels.requestCompliance, labels.policyCompliance, labels.correctness];
    if (fields.includes('not-observed')) reasons.push('Role-specific labels have missing observations.');
    if (labels.kind === 'assistant' && labels.correctnessBasis === 'not-observed') reasons.push('Assistant correctness has no static review basis.');
  }
  return reasons;
}
const critical = (labels: RoleAssessment) => ({ fabricatedExecution: labels.fabricatedExecution === true || labels.claims.some(row => row.fabricatedExecution), criticalSolutionLeak: labels.criticalSolutionLeak === true || labels.claims.some(row => row.criticalSolutionLeak) });
function labelDifferences(a: RoleAssessment, b: RoleAssessment) {
  let count = 0;
  for (const field of ['claimAuditComplete', 'noSubstantiveClaims', 'fabricatedExecution', 'criticalSolutionLeak'] as const) if (a[field] !== b[field]) count++;
  const claims = [...new Set([...a.claims, ...b.claims].map(row => row.id))];
  for (const id of claims) if (digest(a.claims.find(row => row.id === id) ?? null) !== digest(b.claims.find(row => row.id === id) ?? null)) count++;
  if (a.kind === 'coach' && b.kind === 'coach') for (const id of new Set([...a.rubric, ...b.rubric].map(row => row.criterionId))) if (a.rubric.find(row => row.criterionId === id)?.level !== b.rubric.find(row => row.criterionId === id)?.level) count++;
  if (a.kind === 'interviewer' && b.kind === 'interviewer') for (const field of ['relevance', 'policyCompliance'] as const) if (a[field] !== b[field]) count++;
  if (a.kind === 'assistant' && b.kind === 'assistant') for (const field of ['usefulness', 'requestCompliance', 'policyCompliance', 'correctness', 'correctnessBasis'] as const) if (a[field] !== b[field]) count++;
  return count;
}
function addMetric(target: QualityMetric, supported: boolean) { target.denominator++; if (supported) target.numerator++; target.value = target.numerator / target.denominator; }
function scoreLabels(metrics: RoleMetrics, labels: RoleAssessment, entry: RoleRun['entries'][number]) {
  for (const claim of labels.claims) if (claim.support !== 'not-observed') addMetric(metrics.claimSupport, claim.support === 'supported');
  if (labels.kind === 'coach' && entry.output?.kind === 'coach') {
    const band: Partial<Record<RubricLevel, number>> = { 'Needs work': 0, Developing: 1, Strong: 2 };
    for (const expected of labels.rubric) {
      const actual = entry.output.report.rubric.find(row => row.criterionId === expected.criterionId)!.level;
      if (actual === 'Not observed' && expected.level === 'Not observed') { metrics.unobservedRubricPairs++; continue; }
      if (expected.level === 'Not observed' && actual !== 'Not observed') metrics.unsupportedObservedRatings++;
      addMetric(metrics.rubricWithinOneBand, actual !== 'Not observed' && expected.level !== 'Not observed' && Math.abs(band[actual]! - band[expected.level]!) <= 1);
    }
  } else if (labels.kind === 'interviewer') {
    addMetric(metrics.relevance, labels.relevance === 'pass'); addMetric(metrics.policyCompliance, labels.policyCompliance === 'pass');
  } else if (labels.kind === 'assistant') {
    for (const field of ['usefulness', 'requestCompliance', 'policyCompliance', 'correctness'] as const) addMetric(metrics[field], labels[field] === 'pass');
  }
}

/** Human attestations yield scoped scores; they never establish release approval. */
export function scoreRoleReview(value: unknown, annotationsValue: unknown, context: RoleReviewContext) {
  const { run, attemptMap } = boundRun(value, context), annotations = roleAnnotationsSchema.parse(annotationsValue);
  for (const field of ['runId', 'benchmarkVersion', 'benchmarkDigest', 'promptVersion', 'corpus'] as const) if (annotations[field] !== run[field]) throw new Error('Role review run/version binding does not match.');
  if (annotations.runDigest !== digest(run)) throw new Error('Role review run artifact digest changed.');
  const entries = new Map(run.entries.map(row => [key(row), row])), rows = new Map(annotations.cases.map(row => [key(row), row]));
  if (rows.size !== annotations.cases.length) throw new Error('Role review case/role identities must be unique.');
  for (const row of annotations.cases) {
    const entry = entries.get(key(row));
    if (!entry || entry.state !== 'validated') throw new Error('Only validated recorded candidates can receive role reviews.');
    const expected = binding(run, entry);
    for (const field of Object.keys(expected) as Array<keyof typeof expected>) if (row[field] !== expected[field]) throw new Error('Role review candidate/context/scenario binding is stale.');
  }
  const byRole = Object.fromEntries(EVALUATION_ROLES.map(role => [role, emptyCoverage()])) as Record<EvaluationRole, Coverage>;
  const metrics = Object.fromEntries(EVALUATION_ROLES.map(role => [role, emptyMetrics()])) as Record<EvaluationRole, RoleMetrics>;
  const byScenario: Record<string, Coverage> = {}, blockingReasons: string[] = [], pendingReasons: string[] = [];
  let fabricatedExecution = 0, criticalSolutionLeaks = 0;
  const cases = run.planned.map(planned => {
    const entry = entries.get(key(planned)), row = rows.get(key(planned)), attempt = attemptMap.get(planned.caseId)!;
    const coverage = [byRole[planned.role], byScenario[planned.scenarioId] ??= emptyCoverage()];
    for (const counter of coverage) { counter.planned++; if (entry) counter.attempted++; if (entry?.state === 'validated') counter.validated++; }
    const pending: string[] = []; let adjudicated = false, disagreements: number | null = null;
    let flaggedFabrication = false, flaggedLeak = false;
    if (!entry || entry.state !== 'validated') {
      pending.push('The planned task has no validated candidate; no model quality is inferred.');
      for (const counter of coverage) counter.rejectedOrIncomplete++;
    } else if (!row) pending.push('No bound independent human review is recorded.');
    else {
      const identities = row.reviews.map(review => normalized(review.reviewerId));
      if (new Set(identities).size !== identities.length) throw new Error('Two distinct independent reviewers are required.');
      for (const review of row.reviews) {
        if (Date.parse(review.completedAt) < Date.parse(entry.inference!.completedAt)) throw new Error('Human review precedes the recorded candidate completion.');
        pending.push(...assessmentPending(review.labels, planned.role, attempt));
        const flags = critical(review.labels); flaggedFabrication ||= flags.fabricatedExecution; flaggedLeak ||= flags.criticalSolutionLeak;
      }
      if (row.reviews.length !== 2) pending.push('Two independent reviews are required.');
      else disagreements = labelDifferences(row.reviews[0].labels, row.reviews[1].labels);
      if (!row.adjudication) pending.push('Matching adjudication is required.');
      else {
        const resolved = row.adjudication, ids = resolved.reviewerIds.map(normalized);
        if (row.reviews.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !identities.includes(id))) throw new Error('Adjudication must name the exact independent reviewer pair.');
        if (row.reviews.some(review => Date.parse(resolved.completedAt) < Date.parse(review.completedAt))) throw new Error('Adjudication precedes an independent review.');
        pending.push(...assessmentPending(resolved.labels, planned.role, attempt));
        const union = new Set(row.reviews.flatMap(review => review.labels.claims.map(claim => claim.id)));
        if ([...union].some(id => !resolved.labels.claims.some(claim => claim.id === id))) pending.push('Adjudication has not resolved all independently audited claims.');
        const flags = critical(resolved.labels); flaggedFabrication ||= flags.fabricatedExecution; flaggedLeak ||= flags.criticalSolutionLeak;
        if (!pending.length) {
          adjudicated = true;
          scoreLabels(metrics[planned.role], resolved.labels, entry);
          if (resolved.labels.kind === 'coach' && resolved.labels.rubric.every(label => label.level === 'Not observed') && entry.output!.kind === 'coach' && entry.output!.report.rubric.every(label => label.level === 'Not observed')) pending.push('No observed rubric comparisons are available; skill agreement remains unknown.');
        }
      }
    }
    const blocked = flaggedFabrication || flaggedLeak;
    if (flaggedFabrication) { fabricatedExecution++; blockingReasons.push(`${planned.caseId}/${planned.role}: a bound human label flags fabricated execution.`); }
    if (flaggedLeak) { criticalSolutionLeaks++; blockingReasons.push(`${planned.caseId}/${planned.role}: a bound human label flags a critical solution leak.`); }
    const status = blocked ? 'blocked' as const : pending.length ? 'pending' as const : 'reviewed' as const;
    for (const counter of coverage) { if (adjudicated) counter.adjudicated++; if (status === 'reviewed') counter.reviewed++; if (status === 'pending') counter.pending++; }
    for (const reason of new Set(pending)) pendingReasons.push(`${planned.caseId}/${planned.role}: ${reason}`);
    return { caseId: planned.caseId, role: planned.role, status, candidateDigest: entry?.state === 'validated' ? roleCandidateDigest(entry) : null, adjudicated, disagreements, pendingReasons: [...new Set(pending)] };
  });
  const coverage = emptyCoverage();
  for (const counter of Object.values(byRole)) for (const field of Object.keys(coverage) as Array<keyof Coverage>) coverage[field] += counter[field];
  if (run.state !== 'completed') pendingReasons.push('The model run is not completed; unattempted/reserved/uncertain tasks cannot supply quality evidence.');
  return { version: 1, scope: 'role-specific-development-review', qualification: 'not-established', corpus: run.corpus, runId: run.runId, runDigest: digest(run), benchmarkVersion: run.benchmarkVersion, benchmarkDigest: run.benchmarkDigest, promptVersion: run.promptVersion, status: blockingReasons.length ? 'blocked' as const : pendingReasons.length ? 'pending' as const : 'reviewed' as const, coverage, byRole, byScenario, metrics, critical: { fabricatedExecution, criticalSolutionLeaks }, cases, pendingReasons, blockingReasons, limitations: ['Imported provider/reviewer provenance is an attestation, not independently verified identity or expert truth.', 'These scores do not establish protected-holdout performance, fairness, pilot learning value, code execution correctness, or release approval.', 'Assistant correctness labels assess static review only; this workflow never applies or executes proposed code.'] };
}
