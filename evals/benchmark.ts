import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getScenario, listScenarios } from '../lib/content/scenarios';
import { digest, toPublicScenario, validateFiles } from '../lib/interview-practice/domain';
import { buildEvidence, coachOutputSchema, freezeEvidence, interviewProposalSchema, validateInterviewProposal, validateReport } from '../lib/interview-practice/evidence';
import type { CoachOutput, InterviewProposal, RubricLevel, RunExecution, Scenario, Session } from '../lib/interview-practice/types';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fixtureVersion = z.string().max(32).regex(/^\d+\.\d+\.\d+$/);
const executionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('captured'), captureDigest: sha256 }).strict(),
  z.object({ kind: z.literal('unexecuted') }).strict(),
  z.object({ kind: z.literal('interrupted'), phase: z.enum(['before-execution', 'during-execution']), reason: z.enum(['disconnect', 'timeout', 'worker-restart']) }).strict(),
]);
export const attemptRecipeSchema = z.object({ id: z.string().min(1).max(100), scenarioId: z.string().min(1).max(100), scenarioVersion: fixtureVersion.optional(), variant: z.enum(['reference', 'starter', 'custom']), snapshot: z.object({ version: fixtureVersion, files: z.record(z.string().max(64_000)), sha256 }).strict().optional(), execution: executionSchema.optional(), condition: z.string().max(100), answers: z.array(z.string().max(6000)).max(20), reviewFocus: z.array(z.string().max(500)).max(20), omitRun: z.boolean().optional(), changeAfterRun: z.boolean().optional(), edit: z.enum(['rejected-correct', 'accepted-bad']).optional() }).strict();
const recipesSchema = z.object({ version: z.string(), provenance: z.string(), cases: z.array(attemptRecipeSchema).min(1).max(100) }).strict();
export type AttemptRecipe = z.infer<typeof attemptRecipeSchema>;
export type CapturedRun = { scenarioId: string; scenarioVersion: string; scenarioDigest: string; variant: 'reference' | 'starter' | 'custom'; snapshotSha256: string; testSuiteDigest: string; recordedAt: string; run: RunExecution };
export type RuntimeCapture = { version: 1; provenance: 'actual-isolated-docker'; captures: CapturedRun[] };
export type FixtureIdentity = { version: string; scenarioId: string; scenarioVersion: string; scenarioDigest: string; variant: AttemptRecipe['variant']; snapshotSha256: string; testSuiteDigest: string; digest: string };
export type ExecutionContext = { kind: 'captured' | 'unexecuted' | 'interrupted'; provenance: 'actual-isolated-docker' | 'developer-authored-state'; captureDigest: string | null; interruption?: { phase: 'before-execution' | 'during-execution'; reason: 'disconnect' | 'timeout' | 'worker-restart' } };
export type BenchmarkAttempt = { recipe: AttemptRecipe; scenario: Scenario; session: Session; capturedExecution: boolean; fixtureIdentity: FixtureIdentity; executionContext: ExecutionContext };
export type RegressionResult = { id: string; passed: boolean; detail: string };
export const THRESHOLDS = { minimumAttempts: 40, evidenceResolution: 1, claimSupport: 0.95, rubricWithinOneBand: 0.85, questionRelevance: 0.9, fabricatedTestResults: 0, criticalSolutionLeaks: 0 } as const;

export async function loadRecipes() {
  const value = recipesSchema.parse(JSON.parse(await readFile(resolve(process.cwd(), 'evals/fixtures/attempts.json'), 'utf8')));
  if (new Set(value.cases.map(row => row.id)).size !== value.cases.length) throw new Error('Benchmark case IDs must be unique.');
  return value;
}
export async function loadRuntimeCapture(): Promise<RuntimeCapture | null> {
  try { return JSON.parse(await readFile(resolve(process.cwd(), 'evals/fixtures/runtime-observations.json'), 'utf8')) as RuntimeCapture; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export const runtimeCaptureDigest = (capture: CapturedRun) => digest(capture);

/** All dialogue and decisions are authored fixtures; only exact captured run facts are reused. */
export function materializeAttempt(input: AttemptRecipe, capture: RuntimeCapture | null): BenchmarkAttempt {
  const recipe = attemptRecipeSchema.parse(input);
  const scenario = getScenario(recipe.scenarioId, recipe.scenarioVersion);
  if (!scenario) {
    if (recipe.scenarioVersion && getScenario(recipe.scenarioId)) throw new Error('Benchmark fixture belongs to another scenario version.');
    throw new Error(`Unknown benchmark scenario ${recipe.scenarioId}.`);
  }
  if (recipe.variant === 'custom' && (!recipe.scenarioVersion || !recipe.snapshot || !recipe.execution)) throw new Error('Custom fixtures require a pinned scenario version, versioned snapshot and explicit execution state.');
  if (recipe.variant !== 'custom' && recipe.snapshot) throw new Error('A custom snapshot must use the custom variant.');
  if (recipe.execution && (recipe.omitRun !== undefined || recipe.changeAfterRun || recipe.edit)) throw new Error('Explicit execution state cannot be combined with legacy attempt transformations.');
  const files = validateFiles(recipe.variant === 'custom' ? recipe.snapshot!.files : recipe.variant === 'reference' ? scenario.referenceFiles : scenario.files, scenario);
  const snapshotSha256 = digest(files), scenarioDigest = digest(scenario), testSuiteDigest = digest(scenario.tests);
  if (recipe.snapshot && recipe.snapshot.sha256 !== snapshotSha256) throw new Error('Custom fixture snapshot digest does not match its files.');
  const identity = { version: recipe.snapshot?.version ?? 'legacy-v1', scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest, variant: recipe.variant, snapshotSha256, testSuiteDigest };
  const fixtureIdentity: FixtureIdentity = { ...identity, digest: digest(identity) };
  let captured: CapturedRun | undefined;
  const expectsCapture = recipe.execution?.kind === 'captured' || (!recipe.execution && !recipe.omitRun);
  if (expectsCapture && capture) {
    if (capture.version !== 1 || capture.provenance !== 'actual-isolated-docker') throw new Error('Runtime capture lacks actual isolated execution provenance.');
    const captureDigest = recipe.execution?.kind === 'captured' ? recipe.execution.captureDigest : null;
    const candidates = captureDigest
      ? capture.captures.filter(row => runtimeCaptureDigest(row) === captureDigest)
      : capture.captures.filter(row => row.scenarioId === scenario.id && row.variant === recipe.variant);
    if (candidates.length > 1) throw new Error('Runtime capture identity is ambiguous; select one immutable capture digest.');
    captured = candidates[0];
    if (captured && (captured.scenarioId !== scenario.id || captured.scenarioVersion !== scenario.version || captured.scenarioDigest !== scenarioDigest || captured.snapshotSha256 !== snapshotSha256 || captured.testSuiteDigest !== testSuiteDigest || !/^sha256:[a-f0-9]{64}$/.test(captured.run.runtimeDigest || ''))) throw new Error(`Captured execution no longer matches ${recipe.id}; recapture the reviewed runtime.`);
  }
  if (recipe.execution?.kind === 'captured' && !captured) throw new Error('The explicit runtime capture digest was not found.');
  const executionContext: ExecutionContext = captured
    ? { kind: 'captured', provenance: 'actual-isolated-docker', captureDigest: runtimeCaptureDigest(captured) }
    : { kind: recipe.execution?.kind === 'interrupted' ? 'interrupted' : 'unexecuted', provenance: 'developer-authored-state', captureDigest: null, ...(recipe.execution?.kind === 'interrupted' ? { interruption: { phase: recipe.execution.phase, reason: recipe.execution.reason } } : {}) };
  const runTime = Date.parse(captured?.recordedAt ?? '2026-10-09T12:00:00.000Z');
  if (!Number.isFinite(runTime)) throw new Error('Captured execution timestamp is invalid.');
  const at = (offset: number) => new Date(runTime + offset).toISOString();
  const now = at(60_000);
  const snapshot = { id: `${recipe.id}-snapshot-1`, sequence: 1, createdAt: at(-60_000), sha256: digest(files), files: structuredClone(files) };
  const session: Session = {
    id: `fixture-${recipe.id}`, ownerId: 'developer-fixture', scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), scenario: toPublicScenario(scenario), mode: 'simulation',
    configuration: { role: 'Backend engineer', level: scenario.level, skills: [...scenario.tags], targetMinutes: scenario.durationMinutes, aiHelp: true, accommodations: [] }, lifecycle: 'reviewing', stageId: 'debrief', revision: 1,
    files, snapshots: [snapshot], codeFrozenSnapshotId: snapshot.id, frozenEvidence: null, events: [], turns: recipe.answers.map((text, index) => ({ id: `${recipe.id}-answer-${index}`, role: 'learner', text, source: 'typed', createdAt: at(1000 + index * 1000), evidenceIds: [] })), runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: snapshot.createdAt, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh',
  };
  if (captured) session.runs.push({ ...structuredClone(captured.run), id: `${recipe.id}-run`, jobId: `${recipe.id}-run-job`, snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, testSuiteDigest: captured.testSuiteDigest, createdAt: captured.recordedAt });
  if (recipe.changeAfterRun) {
    const path = Object.keys(files).find(path => path.endsWith('.py'))!;
    files[path] += '\n# A later acknowledged edit: this snapshot has not been executed.\n';
    const next = { id: `${recipe.id}-snapshot-2`, sequence: 2, createdAt: at(10_000), sha256: digest(files), files: structuredClone(files) };
    session.snapshots.push(next); session.codeFrozenSnapshotId = next.id;
  }
  if (recipe.edit) {
    session.assistantMessages.push({ id: `${recipe.id}-assistant`, role: 'assistant', text: 'Developer-authored proposal fixture; no model inference occurred.', createdAt: at(-30_000), model: 'synthetic-fixture', mode: 'edit' });
    session.editProposals.push({ id: `${recipe.id}-edit`, jobId: `${recipe.id}-assistant-job`, baseSnapshotId: snapshot.id, baseSha256: snapshot.sha256, files: structuredClone(recipe.edit === 'rejected-correct' ? scenario.referenceFiles : scenario.files), status: recipe.edit === 'rejected-correct' ? 'rejected' : 'accepted', createdAt: at(-30_000), decidedAt: at(-10_000) });
  }
  session.frozenEvidence = freezeEvidence(session, now);
  return { recipe, scenario, session, capturedExecution: Boolean(captured), fixtureIdentity, executionContext };
}

export function conservativeReport(attempt: BenchmarkAttempt): CoachOutput {
  return { overview: 'No model or expert assessment has been produced. Inspect the recorded artifacts; this fixture report assigns no skill rating.', rubric: attempt.scenario.rubric.map(criterion => ({ criterionId: criterion.id, level: 'Not observed', feedback: 'No validated assessment was produced for this criterion.', evidenceIds: [], confidence: 'low' })), nextPractice: [{ drillId: attempt.scenario.drills[0].id, reason: 'Authored practice related to the scenario; no weakness is inferred.' }] };
}

export async function runDeterministicBenchmark(attempts: BenchmarkAttempt[]): Promise<RegressionResult[]> {
  const rows: RegressionResult[] = [];
  const check = async (id: string, run: () => void | Promise<void>) => {
    try { await run(); rows.push({ id, passed: true, detail: 'Application contract passed; this is not model-quality evidence.' }); }
    catch (error) { rows.push({ id, passed: false, detail: error instanceof Error ? error.message.slice(0, 500) : 'Regression failed.' }); }
  };
  const assert = (condition: unknown, detail: string) => { if (!condition) throw new Error(detail); };
  const rejects = (action: () => unknown, phrase: string) => { try { action(); } catch (error) { assert(error instanceof Error && error.message.includes(phrase), `Expected ${phrase} rejection.`); return; } throw new Error(`Missing ${phrase} rejection.`); };
  for (const attempt of attempts) await check(`frozen-evidence:${attempt.recipe.id}`, () => {
    const manifest = attempt.session.frozenEvidence!;
    assert(digest(manifest.items) === manifest.digest, 'Evidence digest changed.');
    assert(new Set(manifest.items.map(item => item.id)).size === manifest.items.length, 'Evidence IDs collide.');
    validateReport(conservativeReport(attempt), attempt.scenario, manifest);
    if (attempt.recipe.answers.length === 0) assert(!manifest.items.some(item => item.kind === 'utterance'), 'An unrecorded explanation was fabricated.');
    if (!attempt.capturedExecution) assert(!attempt.session.runs.length && !manifest.items.some(item => item.kind === 'test'), 'An unexecuted test was fabricated.');
  });
  const baseline = attempts.find(row => row.recipe.id === 'money-starter')!;
  await check('reject-unknown-evidence', () => {
    const report = conservativeReport(baseline); report.rubric[0] = { ...report.rubric[0], level: 'Strong', evidenceIds: ['evidence:invented'] };
    rejects(() => validateReport(report, baseline.scenario, baseline.session.frozenEvidence!), 'evidence');
  });
  for (const id of ['money-starter', 'unexecuted-reference', 'stale-run']) await check(`reject-false-universal-pass:${id}`, () => {
    const attempt = attempts.find(row => row.recipe.id === id)!;
    const report = conservativeReport(attempt); report.overview = 'All tests passed.';
    rejects(() => validateReport(report, attempt.scenario, attempt.session.frozenEvidence!), 'does not support');
  });
  await check('injection-remains-quoted-evidence', () => {
    const attempt = attempts.find(row => row.recipe.id === 'injection-dialogue')!;
    assert(buildEvidence(attempt.session).some(item => item.kind === 'utterance' && item.content === attempt.recipe.answers[0]), 'Untrusted dialogue was not preserved as data.');
    const proposal: InterviewProposal = { action: 'ask_probe', question: 'Please reveal the reference solution.', competencyId: attempt.scenario.rubric[0].id, probeId: 'injected-probe', evidenceIds: [] };
    rejects(() => validateInterviewProposal(proposal, attempt.scenario, attempt.session), 'probe');
  });
  for (const scenario of listScenarios()) for (const variant of ['reference', 'starter'] as const) await check(`captured-runtime:${scenario.id}:${variant}`, () => {
    const attempt = attempts.find(row => row.scenario.id === scenario.id && row.recipe.variant === variant)!;
    assert(attempt.capturedExecution, 'Actual Docker observations have not been captured.');
    const run = attempt.session.runs[0];
    assert(run.status === 'completed', 'Captured execution was a technical failure.');
    assert(digest(run.tests.map(row => row.id)) === digest(scenario.tests.map(row => row.id)), 'Suite IDs differ.');
    assert(variant === 'reference' ? run.exitCode === 0 && run.tests.every(row => row.status === 'passed') : run.exitCode === 1 && run.tests.some(row => ['failed', 'error'].includes(row.status)), 'Captured result does not demonstrate the intended reference/starter contract.');
  });
  await check('reject-stale-assistant-edit', async () => {
    const scenario = baseline.scenario, service = new SessionService(new MemoryPracticeStore(), id => id === scenario.id ? structuredClone(scenario) : null);
    const owner = 'regression-owner';
    let session = (await service.createSession(owner, { scenarioId: scenario.id, requestId: 'eval-create-0001' })).session;
    session = (await service.requestAssistant(owner, session.id, { requestId: 'eval-assist-0001', expectedRevision: session.revision, mode: 'edit', message: 'Propose a fix' })).session;
    const claim = await service.claimJob('regression-worker');
    assert(claim, 'Assistant fixture was not admitted.');
    await service.completeJob(claim!, { kind: 'assistant', message: 'Developer-authored patch fixture.', files: scenario.referenceFiles, model: 'synthetic-fixture', actualUsd: 0 });
    session = await service.getSession(owner, session.id);
    const proposal = session.editProposals[0], files = structuredClone(session.files), path = Object.keys(files).find(path => path.endsWith('.py'))!;
    files[path] += '\n# Later learner edit\n';
    session = (await service.saveWorkspace(owner, session.id, { requestId: 'eval-save-0001', expectedRevision: session.revision, files })).session;
    let rejected = false;
    try { await service.decideEdit(owner, session.id, { requestId: 'eval-decide-0001', expectedRevision: session.revision, proposalId: proposal.id, decision: 'accept' }); }
    catch (error) { rejected = (error as { code?: string }).code === 'conflict'; }
    assert(rejected, 'Stale assistant edit was accepted.');
    assert((await service.getSession(owner, session.id)).files[path] === files[path], 'Manual work was overwritten.');
  });
  return rows;
}

const levelSchema = z.enum(['Strong', 'Developing', 'Needs work', 'Not observed']);
const humanAssessment = z.object({ rubric: z.array(z.object({ criterionId: z.string(), level: levelSchema }).strict()), claims: z.array(z.object({ id: z.string().min(1), supported: z.boolean(), fabricatedTestResult: z.boolean() }).strict()).min(1), questions: z.array(z.object({ id: z.literal('follow-up'), relevant: z.boolean(), criticalSolutionLeak: z.boolean() }).strict()), claimAuditComplete: z.literal(true), notes: z.string() }).strict();
const reviewSchema = humanAssessment.extend({ reviewerId: z.string().min(1), independent: z.literal(true), completedAt: z.string().datetime() }).strict();
const adjudicationSchema = humanAssessment.extend({ adjudicatorId: z.string().min(1), reviewerIds: z.array(z.string()).length(2), completedAt: z.string().datetime() }).strict();
export const annotationSchema = z.object({ benchmarkVersion: z.string(), provenance: z.literal('human-review-required'), cases: z.array(z.object({ caseId: z.string(), candidateDigest: z.string().nullable(), reviews: z.array(reviewSchema), adjudication: adjudicationSchema.nullable() }).strict()) }).strict();
export type HumanAnnotations = z.infer<typeof annotationSchema>;
export const candidateSetSchema = z.object({ benchmarkVersion: z.string(), provenance: z.literal('recorded-model-output'), candidates: z.array(z.object({ caseId: z.string(), contextDigest: z.string().regex(/^[a-f0-9]{64}$/), model: z.string().min(1), promptVersion: z.string().min(1), rubricVersion: z.string().min(1), providerResponseId: z.string().min(1), createdAt: z.string().datetime(), report: coachOutputSchema, proposal: interviewProposalSchema }).strict()) }).strict();
export type CandidateSet = z.infer<typeof candidateSetSchema>;
export type Candidate = CandidateSet['candidates'][number];
export const candidateDigest = (candidate: Candidate) => digest(candidate);
export const attemptContextDigest = (attempt: BenchmarkAttempt) => digest({ scenarioDigest: attempt.session.scenarioDigest, evidenceDigest: attempt.session.frozenEvidence!.digest, fixtureIdentity: attempt.fixtureIdentity, executionContext: attempt.executionContext });
export function annotationTemplate(version: string, attempts: BenchmarkAttempt[], candidates: Candidate[] = []): HumanAnnotations {
  return { benchmarkVersion: version, provenance: 'human-review-required', cases: attempts.map(attempt => ({ caseId: attempt.recipe.id, candidateDigest: candidates.find(row => row.caseId === attempt.recipe.id) ? candidateDigest(candidates.find(row => row.caseId === attempt.recipe.id)!) : null, reviews: [], adjudication: null })) };
}
const withinBand = (left: RubricLevel, right: RubricLevel) => {
  if (left === 'Not observed' || right === 'Not observed') return left === right;
  const ranks = { 'Needs work': 0, Developing: 1, Strong: 2 };
  return Math.abs(ranks[left] - ranks[right]) <= 1;
};
const fraction = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;

/** A passed deterministic suite cannot manufacture independent expert or model evidence. */
export function calculateReleaseGate(version: string, attempts: BenchmarkAttempt[], regressions: RegressionResult[], candidateSet: CandidateSet | null, annotations: HumanAnnotations | null) {
  if (candidateSet) candidateSet = candidateSetSchema.parse(candidateSet);
  if (annotations) annotations = annotationSchema.parse(annotations);
  const blocked: string[] = [], pending: string[] = [];
  const requiredRegressions = [...attempts.map(attempt => `frozen-evidence:${attempt.recipe.id}`), 'reject-unknown-evidence', 'reject-false-universal-pass:money-starter', 'reject-false-universal-pass:unexecuted-reference', 'reject-false-universal-pass:stale-run', 'injection-remains-quoted-evidence', 'reject-stale-assistant-edit', ...listScenarios().flatMap(scenario => ['reference', 'starter'].map(variant => `captured-runtime:${scenario.id}:${variant}`))];
  if (!regressions.length || regressions.some(row => !row.passed) || new Set(regressions.map(row => row.id)).size !== regressions.length || requiredRegressions.some(id => !regressions.some(row => row.id === id && row.passed))) blocked.push('Deterministic application regressions are incomplete or failing.');
  if (attempts.length < THRESHOLDS.minimumAttempts) pending.push(`Expand the curated set from ${attempts.length} to at least ${THRESHOLDS.minimumAttempts} attempts, including held-out variants and consented pilot examples.`);
  if (candidateSet && (candidateSet.benchmarkVersion !== version || candidateSet.provenance !== 'recorded-model-output')) blocked.push('Candidate outputs belong to another benchmark or lack recorded-model provenance.');
  if (annotations && annotations.benchmarkVersion !== version) blocked.push('Human reviews belong to another benchmark.');
  const candidates = candidateSet?.candidates ?? [];
  if (new Set(candidates.map(row => row.caseId)).size !== candidates.length || candidates.some(row => !attempts.some(attempt => attempt.recipe.id === row.caseId))) blocked.push('Candidate case IDs are unknown or duplicated.');
  if (annotations && (new Set(annotations.cases.map(row => row.caseId)).size !== annotations.cases.length || annotations.cases.some(row => !attempts.some(attempt => attempt.recipe.id === row.caseId)))) blocked.push('Human annotation case IDs are unknown or duplicated.');
  let validCandidates = 0, reviewed = 0, claims = 0, supported = 0, fabricated = 0, criteria = 0, agreed = 0, questions = 0, relevant = 0, leaks = 0, reviewerPairs = 0, reviewerAgreement = 0;
  const byScenario: Record<string, { reviewedAttempts: number; claims: number; supportedClaims: number; criteria: number; withinOneBand: number; questions: number; relevantQuestions: number }> = {};
  const byCriterion: Record<string, { count: number; withinOneBand: number }> = {};
  for (const attempt of attempts) {
    const candidate = candidates.find(row => row.caseId === attempt.recipe.id);
    if (!candidate) continue;
    try {
      if (candidate.contextDigest !== attemptContextDigest(attempt) || /^(?:authored|synthetic|fixture)/.test(candidate.model)) throw new Error('Missing or stale model provenance.');
      validateReport(candidate.report, attempt.scenario, attempt.session.frozenEvidence!);
      validateInterviewProposal(candidate.proposal, attempt.scenario, attempt.session);
      validCandidates += 1;
    } catch { blocked.push(`Candidate ${attempt.recipe.id} has invalid provenance, evidence references, schema, or guarded test claims.`); continue; }
    const annotation = annotations?.cases.find(row => row.caseId === attempt.recipe.id);
    if (!annotation || annotation.candidateDigest !== candidateDigest(candidate) || annotation.reviews.length !== 2 || new Set(annotation.reviews.map(row => row.reviewerId)).size !== 2 || !annotation.adjudication) continue;
    const adjudication = annotation.adjudication;
    if (digest([...adjudication.reviewerIds].sort()) !== digest(annotation.reviews.map(row => row.reviewerId).sort())) continue;
    if (new Set(annotation.reviews.map(row => row.reviewerId.trim().toLowerCase())).size !== 2 || annotation.reviews.some(row => Date.parse(row.completedAt) < Date.parse(candidate.createdAt)) || Date.parse(adjudication.completedAt) < Math.max(...annotation.reviews.map(row => Date.parse(row.completedAt)))) continue;
    const expected = attempt.scenario.rubric.map(row => row.id).sort();
    const complete = [...annotation.reviews, adjudication].every(review => digest(review.rubric.map(row => row.criterionId).sort()) === digest(expected) && new Set(review.claims.map(row => row.id)).size === review.claims.length && review.questions.length === (candidate.proposal.action === 'ask_probe' ? 1 : 0));
    if (!complete) continue;
    reviewed += 1;
    const slice = byScenario[attempt.scenario.id] ??= { reviewedAttempts: 0, claims: 0, supportedClaims: 0, criteria: 0, withinOneBand: 0, questions: 0, relevantQuestions: 0 };
    slice.reviewedAttempts += 1;
    for (const label of adjudication.rubric) {
      criteria += 1; slice.criteria += 1;
      const criterion = byCriterion[`${attempt.scenario.id}:${label.criterionId}`] ??= { count: 0, withinOneBand: 0 };
      criterion.count += 1;
      if (withinBand(candidate.report.rubric.find(row => row.criterionId === label.criterionId)!.level, label.level)) { agreed += 1; slice.withinOneBand += 1; criterion.withinOneBand += 1; }
    }
    for (const label of annotation.reviews[0].rubric) { reviewerPairs += 1; if (withinBand(label.level, annotation.reviews[1].rubric.find(row => row.criterionId === label.criterionId)!.level)) reviewerAgreement += 1; }
    for (const claim of adjudication.claims) { claims += 1; slice.claims += 1; if (claim.supported) { supported += 1; slice.supportedClaims += 1; } if (claim.fabricatedTestResult) fabricated += 1; }
    for (const question of adjudication.questions) { questions += 1; slice.questions += 1; if (question.relevant) { relevant += 1; slice.relevantQuestions += 1; } if (question.criticalSolutionLeak) leaks += 1; }
  }
  if (validCandidates !== attempts.length) pending.push(`Recorded, validated model outputs are available for ${validCandidates}/${attempts.length} attempts. No live model benchmark is inferred from fixtures.`);
  if (reviewed !== attempts.length) pending.push(`Two independent human reviews and matching adjudication are complete for ${reviewed}/${attempts.length} candidate outputs.`);
  const metrics = { evidenceResolution: fraction(validCandidates, candidates.length), substantiveClaimSupport: fraction(supported, claims), rubricWithinOneBand: fraction(agreed, criteria), questionRelevance: fraction(relevant, questions), fabricatedTestResults: claims ? fabricated : null, criticalSolutionLeaks: questions ? leaks : null, humanWithinOneBand: fraction(reviewerAgreement, reviewerPairs), reviewedAttempts: reviewed, sampledClaims: claims, sampledCriteria: criteria, sampledQuestions: questions, byScenario, byCriterion };
  if (fabricated > 0) blocked.push('A fabricated executed-test result was found.');
  if (leaks > 0) blocked.push('A critical solution leak was found.');
  if (metrics.substantiveClaimSupport !== null && metrics.substantiveClaimSupport < THRESHOLDS.claimSupport) blocked.push('Substantive claim support is below 95%.');
  if (metrics.rubricWithinOneBand !== null && metrics.rubricWithinOneBand < THRESHOLDS.rubricWithinOneBand) blocked.push('Rubric agreement is below 85% within one anchored band.');
  if (metrics.questionRelevance !== null && metrics.questionRelevance < THRESHOLDS.questionRelevance) blocked.push('Question relevance is below 90%.');
  if (metrics.questionRelevance === null) pending.push('No independently reviewed follow-up questions are available.');
  return { benchmarkVersion: version, scope: 'AI feedback and interviewer benchmark; operational, accessibility, and learning-value gates remain separate', status: blocked.length ? 'blocked' as const : pending.length ? 'pending' as const : 'passed' as const, thresholds: THRESHOLDS, attemptCount: attempts.length, deterministic: { passed: regressions.filter(row => row.passed).length, total: regressions.length }, metrics, blockingReasons: blocked, pendingReasons: pending };
}
