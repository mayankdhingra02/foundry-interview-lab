import { z } from 'zod';
import { digest } from '../lib/interview-practice/domain';
import { EVALUATION_ROLES, type EvaluationRole } from './role-runner';
import { assessmentPending, critical, emptyCoverage, emptyMetrics, labelDifferences, roleAnnotationsSchema, scoreLabels, type Coverage, type RoleMetrics } from './role-review';
import { privateRoleRunSchema, privateTaskKey, validatePrivateRoleRun, type PrivateRoleContext, type PrivateRoleRun } from './private-role-runner';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const blindReview = roleAnnotationsSchema.shape.cases.element.shape.reviews.element.extend({ candidateIdentityHidden: z.literal(true), peerReviewsHidden: z.literal(true), packetDigest: hash }).strict();
const privateCaseAnnotation = roleAnnotationsSchema.shape.cases.element.extend({ caseDigest: hash, privateContextDigest: hash, inputContextDigest: hash, executionDigest: hash, runtimeBindingDigest: hash, packetDigest: hash, reviews: z.array(blindReview).max(2) }).strict();
export const privateRoleAnnotationsSchema = roleAnnotationsSchema.omit({ corpus: true, benchmarkVersion: true, benchmarkDigest: true, cases: true }).extend({
  artifact: z.literal('private-corpus-role-annotations'), corpus: privateRoleRunSchema.shape.corpus, corpusDigest: hash, planDigest: hash, cases: z.array(privateCaseAnnotation).max(300),
}).strict();
export type PrivateRoleAnnotations = z.infer<typeof privateRoleAnnotationsSchema>;
const normalize = (id: string) => id.trim().toLowerCase();
function binding(run: PrivateRoleRun, entry: PrivateRoleRun['entries'][number]) {
  const { reservedUsd, runtimeDigests, ...planned } = run.planned.find(row => privateTaskKey(row) === privateTaskKey(entry))!;
  void reservedUsd; void runtimeDigests;
  return { ...planned, candidateDigest: digest(entry) };
}
function packet(bound: ReturnType<typeof validatePrivateRoleRun>, entry: PrivateRoleRun['entries'][number]) {
  const task = bound.tasks.find(row => row.attempt.case.id === entry.caseId && row.role === entry.role)!;
  return { version: 1, artifact: 'private-corpus-blind-review-packet', corpus: bound.run.corpus, corpusDigest: bound.run.corpusDigest, binding: binding(bound.run, entry),
    context: { condition: task.attempt.case.condition, reviewFocus: task.attempt.case.reviewFocus, runtime: task.attempt.case.runtime, execution: task.attempt.execution, conditions: task.attempt.case.conditions, scenario: { ...task.attempt.session.scenario, probes: task.attempt.scenario.probes }, input: task.input, stageId: task.session.stageId, files: task.session.files, turns: task.session.turns, assistantMessages: task.session.assistantMessages, evidence: task.attempt.session.frozenEvidence },
    candidate: entry.output, labels: null, qualification: 'pending-independent-review', blinding: 'candidate-model-cost-provider-metadata-and-peer-labels-omitted',
  };
}
/** Metadata blinding cannot hide a model name volunteered in candidate text. */
export function privateReviewPackets(value: unknown, context: PrivateRoleContext) {
  const bound = validatePrivateRoleRun(value, context);
  return { version: 1, artifact: 'private-corpus-blind-review-packets', corpus: bound.run.corpus, corpusDigest: bound.run.corpusDigest, packets: bound.run.entries.filter(entry => entry.state === 'validated').map(entry => { const body = packet(bound, entry); return { packetDigest: digest(body), ...body }; }), qualification: 'pending-independent-review' };
}
export function privateRoleAnnotationTemplate(value: unknown, context: PrivateRoleContext): PrivateRoleAnnotations {
  const bound = validatePrivateRoleRun(value, context), run = bound.run;
  return { version: 1, artifact: 'private-corpus-role-annotations', provenance: 'human-review-required', corpus: run.corpus, corpusDigest: run.corpusDigest, runId: run.runId, runDigest: digest(run), planDigest: run.planDigest, promptVersion: run.promptVersion, cases: run.entries.filter(entry => entry.state === 'validated').map(entry => ({ ...binding(run, entry), packetDigest: digest(packet(bound, entry)), reviews: [], adjudication: null })) };
}

/** Independent, bound human attestations yield scoped metrics, never approval. */
export function scorePrivateRoleReview(value: unknown, annotationsValue: unknown, context: PrivateRoleContext) {
  const bound = validatePrivateRoleRun(value, context), run = bound.run, annotations = privateRoleAnnotationsSchema.parse(annotationsValue);
  if (digest(annotations.corpus) !== digest(run.corpus) || annotations.corpusDigest !== run.corpusDigest || annotations.runId !== run.runId || annotations.runDigest !== digest(run) || annotations.planDigest !== run.planDigest || annotations.promptVersion !== run.promptVersion) throw new Error('Private annotation run/corpus binding changed.');
  const rows = new Map(annotations.cases.map(row => [privateTaskKey(row), row])), entries = new Map(run.entries.map(row => [privateTaskKey(row), row]));
  if (rows.size !== annotations.cases.length) throw new Error('Private annotation identities must be unique.');
  for (const row of annotations.cases) {
    const entry = entries.get(privateTaskKey(row)); if (!entry || entry.state !== 'validated') throw new Error('Only validated private candidates may be annotated.');
    const expected = { ...binding(run, entry), packetDigest: digest(packet(bound, entry)) };
    for (const field of Object.keys(expected) as Array<keyof typeof expected>) if (row[field] !== expected[field]) throw new Error('Private annotation candidate/context/packet binding changed.');
  }
  const byRole = Object.fromEntries(EVALUATION_ROLES.map(role => [role, emptyCoverage()])) as Record<EvaluationRole, Coverage>;
  const metrics = Object.fromEntries(EVALUATION_ROLES.map(role => [role, emptyMetrics()])) as Record<EvaluationRole, RoleMetrics>;
  const byScenario: Record<string, Coverage> = {}, pendingReasons: string[] = [], blockingReasons: string[] = [];
  let fabricatedExecution = 0, criticalSolutionLeaks = 0;
  const cases = run.planned.map(planned => {
    const entry = entries.get(privateTaskKey(planned)), row = rows.get(privateTaskKey(planned)), attempt = bound.tasks.find(task => task.attempt.case.id === planned.caseId)!.attempt;
    const counters = [byRole[planned.role], byScenario[planned.scenarioId] ??= emptyCoverage()], pending: string[] = [];
    for (const counter of counters) { counter.planned++; if (entry) counter.attempted++; if (entry?.state === 'validated') counter.validated++; }
    let adjudicated = false, disagreements: number | null = null, fabrication = false, leak = false;
    if (!entry || entry.state !== 'validated') { pending.push('No validated candidate exists; no quality is inferred.'); for (const counter of counters) counter.rejectedOrIncomplete++; }
    else if (!row) pending.push('No bound independent blind reviews exist.');
    else {
      const reviewers = row.reviews.map(review => normalize(review.reviewerId)), authors = [run.operatorId, bound.corpus.independence.custodianId, attempt.case.source.preparedBy].map(normalize);
      if (new Set(reviewers).size !== reviewers.length || reviewers.some(id => authors.includes(id))) throw new Error('Blind reviewers must be distinct from each other, the model operator and source custodians/preparers.');
      for (const review of row.reviews) {
        if (review.packetDigest !== row.packetDigest || Date.parse(review.completedAt) < Date.parse(entry.inference!.completedAt)) throw new Error('Private blind review packet/chronology changed.');
        pending.push(...assessmentPending(review.labels, planned.role, attempt)); const flags = critical(review.labels); fabrication ||= flags.fabricatedExecution; leak ||= flags.criticalSolutionLeak;
      }
      if (row.reviews.length !== 2) pending.push('Two independent blind reviews are required.');
      else disagreements = labelDifferences(row.reviews[0].labels, row.reviews[1].labels);
      if (!row.adjudication) pending.push('Matching adjudication is required.');
      else {
        const adjudication = row.adjudication, identities = adjudication.reviewerIds.map(normalize);
        if (row.reviews.length !== 2 || new Set(identities).size !== 2 || identities.some(id => !reviewers.includes(id)) || [...reviewers, ...authors].includes(normalize(adjudication.adjudicatorId))) throw new Error('Adjudication must name the exact reviewer pair and an independent separate adjudicator.');
        if (row.reviews.some(review => Date.parse(adjudication.completedAt) < Date.parse(review.completedAt))) throw new Error('Private adjudication precedes a reviewer.');
        pending.push(...assessmentPending(adjudication.labels, planned.role, attempt));
        const claims = new Set(row.reviews.flatMap(review => review.labels.claims.map(claim => claim.id)));
        if ([...claims].some(id => !adjudication.labels.claims.some(claim => claim.id === id))) pending.push('Adjudication has not resolved every independently audited claim.');
        const flags = critical(adjudication.labels); fabrication ||= flags.fabricatedExecution; leak ||= flags.criticalSolutionLeak;
        if (!pending.length) {
          adjudicated = true; scoreLabels(metrics[planned.role], adjudication.labels, entry);
          if (adjudication.labels.kind === 'coach' && adjudication.labels.rubric.every(label => label.level === 'Not observed') && entry.output!.kind === 'coach' && entry.output!.report.rubric.every(label => label.level === 'Not observed')) pending.push('No observed rubric comparisons exist; skill agreement is unknown.');
        }
      }
    }
    if (fabrication) { fabricatedExecution++; blockingReasons.push(`${planned.caseId}/${planned.role}: a bound human label flags fabricated execution.`); }
    if (leak) { criticalSolutionLeaks++; blockingReasons.push(`${planned.caseId}/${planned.role}: a bound human label flags critical solution leakage.`); }
    const status = fabrication || leak ? 'blocked' as const : pending.length ? 'pending' as const : 'reviewed' as const;
    for (const counter of counters) { if (adjudicated) counter.adjudicated++; if (status === 'reviewed') counter.reviewed++; if (status === 'pending') counter.pending++; }
    for (const reason of new Set(pending)) pendingReasons.push(`${planned.caseId}/${planned.role}: ${reason}`);
    return { caseId: planned.caseId, role: planned.role, status, adjudicated, disagreements, candidateDigest: entry?.state === 'validated' ? digest(entry) : null, pendingReasons: [...new Set(pending)] };
  });
  if (run.state !== 'completed') pendingReasons.push('The recorded run is incomplete; reserved/uncertain/unattempted tasks do not supply quality evidence.');
  const coverage = emptyCoverage(); for (const counter of Object.values(byRole)) for (const field of Object.keys(coverage) as Array<keyof Coverage>) coverage[field] += counter[field];
  return { version: 1, scope: 'private-corpus-role-review', corpus: run.corpus, corpusDigest: run.corpusDigest, runId: run.runId, runDigest: digest(run), planDigest: run.planDigest, promptVersion: run.promptVersion, status: blockingReasons.length ? 'blocked' as const : pendingReasons.length ? 'pending' as const : 'reviewed' as const, qualification: 'not-established', coverage, byRole, byScenario, metrics, critical: { fabricatedExecution, criticalSolutionLeaks }, cases, pendingReasons, blockingReasons, limitations: ['Private corpus, consent, holdout custody, provider provenance, reviewer identities and blinding are operator/human attestations, not independently authenticated facts.', 'Reviewed means this artifact has complete bound labels and adjudication. It does not approve release, establish a sufficient corpus, or prove protected-holdout, pilot, fairness or accessibility qualification.', 'Assistant correctness is static human review only; proposed code is never applied or executed by this workflow.'] };
}
