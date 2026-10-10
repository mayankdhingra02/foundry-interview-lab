import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { conservativeReport, loadRecipes, loadRuntimeCapture, materializeAttempt, type BenchmarkAttempt } from '../evals/benchmark';
import { createRoleContexts, createRolePlan, EVALUATION_ROLES, recordRoleRun, type RoleExecutor, type RoleRun } from '../evals/role-runner';
import { roleAnnotationTemplate, roleAnnotationsSchema, roleCandidateDigest, scoreRoleReview, type RoleAssessment, type RoleReviewContext } from '../evals/role-review';
import { authoredQuestion, PROMPT_VERSION } from '../lib/ai/provider';
import { digest } from '../lib/interview-practice/domain';
import { inferenceBindingDigest } from '../lib/ai/binding';

// Every candidate, identity and label in this file is hypothetical unit data.
// No output is represented as an actual provider response or independent review.
let context: RoleReviewContext, attempt: BenchmarkAttempt, run: RoleRun;
const directories: string[] = [];
const executor: RoleExecutor = async task => {
  const common = { model: 'unit-placeholder-model', actualUsd: 0.00165, inference: { requestedModel: 'gpt-5.4-mini', returnedModel: 'unit-placeholder-model', promptVersion: PROMPT_VERSION, responseId: 'unit-only-not-a-provider-response', inputTokens: 1000, outputTokens: 200, startedAt: '2026-10-09T13:00:01.000Z', completedAt: '2026-10-09T13:00:02.000Z', usd: 0.00165, validated: true, provider: task.inferenceBinding.provider, role: task.inferenceBinding.role, schemaVersion: task.inferenceBinding.schemaVersion, contextVersion: task.inferenceBinding.contextVersion, bindingDigest: inferenceBindingDigest(task.inferenceBinding) } };
  if (task.role === 'interviewer') return { kind: 'interviewer', proposal: authoredQuestion(task.attempt.scenario, task.session), ...common };
  if (task.role === 'coach') {
    const report = conservativeReport(task.attempt), criterion = report.rubric.find(row => !/comprehension|understand|communication|ai[-_]?collaboration/.test(row.criterionId))!;
    criterion.level = 'Developing'; criterion.evidenceIds = [task.attempt.session.frozenEvidence!.items[0].id]; criterion.feedback = 'Hypothetical unit assessment of recorded artifacts.';
    return { kind: 'coach', report, promptVersion: PROMPT_VERSION, ...common };
  }
  return { kind: 'assistant', message: 'Hypothetical unit response, never sent to a provider.', files: {}, ...common };
};
const record = (attempts = [attempt]) => recordRoleRun(context.benchmarkVersion, attempts, { acknowledgePaidApi: true, maxUsd: 1, executor, persist: async () => {}, now: () => new Date('2026-10-09T13:00:00.000Z') });
beforeEach(async () => {
  vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '0.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5'); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400'); vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External calls are forbidden in role-review unit tests.'); }));
  const recipes = await loadRecipes(), capture = await loadRuntimeCapture();
  context = { benchmarkVersion: recipes.version, attempts: recipes.cases.map(recipe => materializeAttempt(recipe, capture)) };
  attempt = context.attempts.find(row => row.recipe.id === 'money-starter')!; run = await record();
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function hypotheticalLabels(entry: RoleRun['entries'][number]): RoleAssessment {
  const common = { claimAuditComplete: true, noSubstantiveClaims: false, claims: [{ id: 'claim-1', support: 'supported' as const, fabricatedExecution: false, criticalSolutionLeak: false }], fabricatedExecution: false, criticalSolutionLeak: false, notes: 'Hypothetical test labels; no human reviewed this candidate.' };
  if (entry.role === 'coach' && entry.output!.kind === 'coach') return { kind: 'coach', ...common, rubric: entry.output!.report.rubric.map(({ criterionId, level }) => ({ criterionId, level })) };
  if (entry.role === 'interviewer') return { kind: 'interviewer', ...common, relevance: 'pass', policyCompliance: 'pass' };
  return { kind: 'assistant', ...common, mode: entry.role.slice('assistant-'.length) as 'ask' | 'plan' | 'edit', usefulness: 'pass', requestCompliance: 'pass', policyCompliance: 'pass', correctness: 'pass', correctnessBasis: 'static-review' };
}
function hypotheticalAnnotations(selected = run) {
  const annotations = roleAnnotationTemplate(selected, context);
  for (const row of annotations.cases) {
    const labels = hypotheticalLabels(selected.entries.find(entry => entry.caseId === row.caseId && entry.role === row.role)!);
    row.reviews = [{ reviewerId: 'hypothetical-a', independent: true, completedAt: '2026-10-09T14:00:00.000Z', labels: structuredClone(labels) }, { reviewerId: 'hypothetical-b', independent: true, completedAt: '2026-10-09T14:01:00.000Z', labels: structuredClone(labels) }];
    row.adjudication = { adjudicatorId: 'hypothetical-adjudicator', reviewerIds: ['hypothetical-a', 'hypothetical-b'], completedAt: '2026-10-09T15:00:00.000Z', labels: structuredClone(labels) };
  }
  return annotations;
}

describe('bound role-specific expert-review import', () => {
  it('creates only blank versioned templates with exact validated entry/context identities', () => {
    const template = roleAnnotationTemplate(run, context);
    expect(roleAnnotationsSchema.parse(template)).toEqual(template); expect(template.cases).toHaveLength(5);
    expect(template.cases.every(row => row.reviews.length === 0 && row.adjudication === null)).toBe(true);
    expect(template.cases.map(row => row.candidateDigest)).toEqual(run.entries.map(roleCandidateDigest));
    const score = scoreRoleReview(run, template, context);
    expect(score.status).toBe('pending'); expect(score.coverage).toMatchObject({ planned: 5, attempted: 5, validated: 5, adjudicated: 0, reviewed: 0 });
    for (const role of EVALUATION_ROLES) expect(score.metrics[role].claimSupport).toEqual({ numerator: 0, denominator: 0, value: null });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('computes separate role/scenario denominators without claiming expert truth or release approval', () => {
    const score = scoreRoleReview(run, hypotheticalAnnotations(), context);
    expect(score).toMatchObject({ status: 'reviewed', corpus: 'development-regression', qualification: 'not-established', critical: { fabricatedExecution: 0, criticalSolutionLeaks: 0 } });
    expect(score.coverage).toMatchObject({ planned: 5, validated: 5, adjudicated: 5, reviewed: 5 });
    expect(score.byScenario[attempt.scenario.id].reviewed).toBe(5);
    expect(score.metrics.coach.rubricWithinOneBand).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(score.metrics.coach.unobservedRubricPairs).toBe(attempt.scenario.rubric.length - 1);
    expect(score.metrics.interviewer.relevance.denominator).toBe(1);
    for (const role of ['assistant-ask', 'assistant-plan', 'assistant-edit'] as const) { expect(score.metrics[role].correctness.denominator).toBe(1); expect(score.byRole[role].reviewed).toBe(1); }
    expect(JSON.stringify(score)).not.toContain('hypothetical-a'); expect(JSON.stringify(score)).not.toContain('Hypothetical test labels');
  });
  it('keeps offline context review independent of unrelated invalid provider pricing', () => {
    const labels = hypotheticalAnnotations(), original = createRoleContexts(context.benchmarkVersion, [attempt]);
    const plan = createRolePlan(context.benchmarkVersion, [attempt]);
    expect(plan.planned.map(({ reservedUsd, ...row }) => { void reservedUsd; return row; })).toEqual(original.contexts);
    vi.stubEnv('OPENAI_MODEL', 'unconfigured-current-model'); vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', 'invalid'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', ''); vi.stubEnv('AI_MAX_OUTPUT_TOKENS', 'bad');
    expect(() => createRolePlan(context.benchmarkVersion, [attempt])).toThrow();
    expect(createRoleContexts(context.benchmarkVersion, [attempt])).toEqual(original);
    expect(scoreRoleReview(run, labels, context).status).toBe('reviewed'); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires exactly two distinct independent reviewers and matching chronological adjudication', () => {
    const one = hypotheticalAnnotations(); one.cases[0].reviews.pop(); one.cases[0].adjudication = null;
    expect(scoreRoleReview(run, one, context).coverage.adjudicated).toBe(4);
    const duplicate = hypotheticalAnnotations(); duplicate.cases[0].reviews[1].reviewerId = ' HYPOTHETICAL-A ';
    expect(() => scoreRoleReview(run, duplicate, context)).toThrow('distinct independent');
    const notIndependent = hypotheticalAnnotations(); (notIndependent.cases[0].reviews[0] as { independent: boolean }).independent = false;
    expect(() => scoreRoleReview(run, notIndependent, context)).toThrow();
    const wrongPair = hypotheticalAnnotations(); wrongPair.cases[0].adjudication!.reviewerIds[1] = 'unknown-reviewer';
    expect(() => scoreRoleReview(run, wrongPair, context)).toThrow('exact independent reviewer pair');
    const earlyReview = hypotheticalAnnotations(); earlyReview.cases[0].reviews[0].completedAt = '2026-10-09T12:59:00.000Z';
    expect(() => scoreRoleReview(run, earlyReview, context)).toThrow('precedes the recorded candidate');
    const earlyAdjudication = hypotheticalAnnotations(); earlyAdjudication.cases[0].adjudication!.completedAt = '2026-10-09T14:00:30.000Z';
    expect(() => scoreRoleReview(run, earlyAdjudication, context)).toThrow('precedes an independent review');
  });
  it('rejects stale candidate, run, prompt, benchmark and scenario/context bindings', () => {
    for (const field of ['benchmarkVersion', 'benchmarkDigest', 'promptVersion'] as const) {
      const labels = hypotheticalAnnotations(); labels[field] = field.endsWith('Digest') ? '0'.repeat(64) : 'another-version'; expect(() => scoreRoleReview(run, labels, context)).toThrow('run/version');
    }
    for (const field of ['candidateDigest', 'contextDigest', 'scenarioDigest', 'evidenceDigest', 'scenarioVersion', 'rubricVersion'] as const) {
      const labels = hypotheticalAnnotations(); labels.cases[0][field] = field.endsWith('Digest') ? '0'.repeat(64) : 'other-version'; expect(() => scoreRoleReview(run, labels, context)).toThrow('binding is stale');
    }
    const labels = hypotheticalAnnotations(), changed = structuredClone(run); if (changed.entries[0].output!.kind === 'interviewer') changed.entries[0].output!.proposal.question += ' Changed';
    expect(() => scoreRoleReview(changed, labels, context)).toThrow();
    const differentRun = structuredClone(run); differentRun.runId = '00000000-0000-4000-8000-000000000000'; expect(() => scoreRoleReview(differentRun, labels, context)).toThrow('run/version');
    const changedJournal = structuredClone(run); changedJournal.policy.inputRate += 0.1; expect(() => scoreRoleReview(changedJournal, labels, context)).toThrow('admitted policy');
    const changedMetadata = structuredClone(run); changedMetadata.createdAt = '2026-10-09T12:59:59.000Z'; expect(() => scoreRoleReview(changedMetadata, labels, context)).toThrow('run artifact digest changed');
    expect(() => scoreRoleReview(run, labels, { ...context, benchmarkVersion: 'different-corpus' })).toThrow('benchmark version');
    const missingAttempt = { ...context, attempts: context.attempts.filter(row => row.recipe.id !== attempt.recipe.id) }; expect(() => scoreRoleReview(run, labels, missingAttempt)).toThrow('unknown authored attempt');
  });
  it('rejects a self-consistent imported hash when the actual authored context changed', () => {
    const changed = structuredClone(run); changed.planned[0].scenarioDigest = '0'.repeat(64);
    changed.benchmarkDigest = digest({ version: changed.benchmarkVersion, planned: changed.planned.map(({ reservedUsd, ...row }) => { void reservedUsd; return row; }) });
    expect(() => roleAnnotationTemplate(changed, context)).toThrow('context or scenario');
    const source = structuredClone(context); source.attempts.find(row => row.recipe.id === attempt.recipe.id)!.session.files['quote.py'] += '\n# Different files';
    expect(() => roleAnnotationTemplate(run, source)).toThrow('context or scenario');
  });
  it('rejects duplicated/unknown review tasks and wrong role-specific label variants', () => {
    const duplicate = hypotheticalAnnotations(); duplicate.cases.push(structuredClone(duplicate.cases[0])); expect(() => scoreRoleReview(run, duplicate, context)).toThrow('identities must be unique');
    const unknown = hypotheticalAnnotations(); unknown.cases[0].caseId = 'unknown-attempt'; expect(() => scoreRoleReview(run, unknown, context)).toThrow('Only validated');
    const wrong = hypotheticalAnnotations(); wrong.cases[0].reviews[0].labels = hypotheticalLabels(run.entries.find(row => row.role === 'coach')!);
    expect(() => scoreRoleReview(run, wrong, context)).toThrow('another role');
    const mode = hypotheticalAnnotations(), assistant = mode.cases.find(row => row.role === 'assistant-ask')!;
    if (assistant.reviews[0].labels.kind === 'assistant') assistant.reviews[0].labels.mode = 'edit';
    expect(() => scoreRoleReview(run, mode, context)).toThrow('assistant mode');
  });
  it('keeps incomplete role labels, null safety flags and missing coach criteria pending', () => {
    const labels = hypotheticalAnnotations(), assistant = labels.cases.find(row => row.role === 'assistant-edit')!, coach = labels.cases.find(row => row.role === 'coach')!;
    if (assistant.adjudication!.labels.kind === 'assistant') { assistant.adjudication!.labels.correctness = 'not-observed'; assistant.adjudication!.labels.correctnessBasis = 'not-observed'; }
    coach.reviews[0].labels.fabricatedExecution = null;
    if (coach.reviews[0].labels.kind === 'coach') coach.reviews[0].labels.rubric.pop();
    const score = scoreRoleReview(run, labels, context);
    expect(score.status).toBe('pending'); expect(score.metrics['assistant-edit'].correctness.value).toBeNull(); expect(score.metrics.coach.rubricWithinOneBand.value).toBeNull();
    expect(score.coverage.adjudicated).toBe(3);
  });
  it('rejects unknown/duplicate criteria, claim identities and contradictory no-claim attestations', () => {
    const criterion = hypotheticalAnnotations(), row = criterion.cases.find(row => row.role === 'coach')!;
    if (row.reviews[0].labels.kind === 'coach') row.reviews[0].labels.rubric[0].criterionId = 'invented';
    expect(() => scoreRoleReview(run, criterion, context)).toThrow('unknown rubric');
    const duplicate = hypotheticalAnnotations(); duplicate.cases[0].reviews[0].labels.claims.push(structuredClone(duplicate.cases[0].reviews[0].labels.claims[0])); expect(() => scoreRoleReview(run, duplicate, context)).toThrow('unique identities');
    const contradiction = hypotheticalAnnotations(); contradiction.cases[0].reviews[0].labels.noSubstantiveClaims = true; expect(() => scoreRoleReview(run, contradiction, context)).toThrow('no-claims attestation');
  });
  it('requires adjudication to cover the union of independent claim audits', () => {
    const labels = hypotheticalAnnotations(); labels.cases[0].reviews[0].labels.claims.push({ id: 'independent-extra-claim', support: 'unsupported', fabricatedExecution: false, criticalSolutionLeak: false });
    const score = scoreRoleReview(run, labels, context); expect(score.status).toBe('pending'); expect(score.cases[0].disagreements).toBe(1); expect(score.metrics.interviewer.claimSupport.value).toBeNull();
    labels.cases[0].adjudication!.labels.claims.push({ id: 'independent-extra-claim', support: 'unsupported', fabricatedExecution: false, criticalSolutionLeak: false });
    const resolved = scoreRoleReview(run, labels, context); expect(resolved.status).toBe('reviewed'); expect(resolved.metrics.interviewer.claimSupport).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
  });
  it('preserves truthful zero denominators for claimless questions and missing skill observations', async () => {
    const claimless = hypotheticalAnnotations(), row = claimless.cases.find(row => row.role === 'interviewer')!;
    for (const labels of [...row.reviews.map(review => review.labels), row.adjudication!.labels]) { labels.noSubstantiveClaims = true; labels.claims = []; }
    const score = scoreRoleReview(run, claimless, context); expect(score.metrics.interviewer.claimSupport).toEqual({ numerator: 0, denominator: 0, value: null }); expect(score.metrics.interviewer.relevance.value).toBe(1);
    const unobservedRun = await recordRoleRun(context.benchmarkVersion, [attempt], { acknowledgePaidApi: true, maxUsd: 1, roles: ['coach'], persist: async () => {}, now: () => new Date('2026-10-09T13:00:00.000Z'), executor: async task => {
      const result = await executor(task); return { kind: 'coach', model: 'unit-placeholder-model', report: conservativeReport(attempt), promptVersion: PROMPT_VERSION, inference: result.inference, actualUsd: result.actualUsd };
    } });
    const unknown = scoreRoleReview(unobservedRun, hypotheticalAnnotations(unobservedRun), context);
    expect(unknown.status).toBe('pending'); expect(unknown.coverage.adjudicated).toBe(1); expect(unknown.coverage.reviewed).toBe(0); expect(unknown.metrics.coach.rubricWithinOneBand.value).toBeNull();
  });
  it('treats Not observed as separate from ordinal bands and exposes unsupported observed ratings', () => {
    const labels = hypotheticalAnnotations(), coach = labels.cases.find(row => row.role === 'coach')!, output = run.entries.find(row => row.role === 'coach')!.output!;
    if (output.kind !== 'coach' || coach.adjudication!.labels.kind !== 'coach') throw new Error('Invalid unit setup.');
    const observed = output.report.rubric.find(row => row.level === 'Developing')!;
    coach.adjudication!.labels.rubric.find(row => row.criterionId === observed.criterionId)!.level = 'Not observed';
    const score = scoreRoleReview(run, labels, context); expect(score.metrics.coach.rubricWithinOneBand).toEqual({ numerator: 0, denominator: 1, value: 0 }); expect(score.metrics.coach.unsupportedObservedRatings).toBe(1);
  });
  it.each(EVALUATION_ROLES)('blocks any bound critical reviewer flag for %s even if adjudication disagrees', role => {
    for (const flag of ['fabricatedExecution', 'criticalSolutionLeak'] as const) {
      const labels = hypotheticalAnnotations(), row = labels.cases.find(row => row.role === role)!; row.reviews[0].labels[flag] = true;
      const score = scoreRoleReview(run, labels, context); expect(score.status).toBe('blocked'); expect(score.cases.find(row => row.role === role)!.status).toBe('blocked'); expect(score.blockingReasons).toHaveLength(1);
    }
  });
  it('does not infer model quality from rejected, unattempted, reserved or uncertain tasks', () => {
    const incomplete = structuredClone(run); incomplete.state = 'running'; incomplete.entries = [];
    const score = scoreRoleReview(incomplete, roleAnnotationTemplate(incomplete, context), context); expect(score.status).toBe('pending'); expect(score.coverage).toMatchObject({ planned: 5, attempted: 0, validated: 0, rejectedOrIncomplete: 5 });
    const rejected = structuredClone(run); rejected.entries[0].state = 'rejected'; rejected.entries[0].failure = 'provider-or-validation'; rejected.entries[0].output = null;
    const template = roleAnnotationTemplate(rejected, context); expect(template.cases).toHaveLength(4);
    const invalid = structuredClone(template); invalid.cases.push(hypotheticalAnnotations().cases[0]); expect(() => scoreRoleReview(rejected, invalid, context)).toThrow('Only validated');
    expect(scoreRoleReview(rejected, template, context).coverage.rejectedOrIncomplete).toBe(1);
    for (const state of ['reserved', 'uncertain'] as const) {
      const unfinished = structuredClone(run); unfinished.entries = [unfinished.entries[0]];
      unfinished.state = state === 'uncertain' ? 'stopped' : 'running'; unfinished.stopReason = state === 'uncertain' ? 'uncertain-charge' : null;
      Object.assign(unfinished.entries[0], { state, output: null, inference: null, knownUsd: 0, uncertainUsd: unfinished.entries[0].reservedUsd, failure: null });
      const result = scoreRoleReview(unfinished, roleAnnotationTemplate(unfinished, context), context);
      expect(result.status).toBe('pending'); expect(result.coverage).toMatchObject({ attempted: 1, validated: 0, adjudicated: 0, rejectedOrIncomplete: 5 });
      expect(result.metrics.interviewer.relevance.value).toBeNull();
    }
  });
  it('rejects a self-consistent incomplete case/role grid and preserves journal chronology', async () => {
    const selected = await record([attempt, context.attempts.find(row => row.recipe.id === 'compatibility-starter')!]);
    selected.planned.pop(); selected.entries.pop();
    selected.benchmarkDigest = digest({ version: selected.benchmarkVersion, planned: selected.planned.map(({ reservedUsd, ...row }) => { void reservedUsd; return row; }) });
    expect(() => roleAnnotationTemplate(selected, context)).toThrow('missing a planned case/role');
    const early = structuredClone(run); early.createdAt = '2026-10-09T13:01:00.000Z'; expect(() => roleAnnotationTemplate(early, context)).toThrow('precedes the run journal');
  });
  it('counts one critical affected task even when multiple reviewers and claim audits flag it', () => {
    const labels = hypotheticalAnnotations(), row = labels.cases[0];
    for (const assessment of [...row.reviews.map(review => review.labels), row.adjudication!.labels]) { assessment.fabricatedExecution = true; assessment.claims[0].fabricatedExecution = true; }
    const score = scoreRoleReview(run, labels, context); expect(score.status).toBe('blocked'); expect(score.critical.fabricatedExecution).toBe(1); expect(score.blockingReasons).toHaveLength(1);
  });
  it('records separate scenario coverage and leaves unselected roles at zero without perfect scores', async () => {
    const other = context.attempts.find(row => row.recipe.id === 'compatibility-starter')!;
    const selected = await recordRoleRun(context.benchmarkVersion, [attempt, other], { acknowledgePaidApi: true, maxUsd: 1, roles: ['assistant-plan'], executor, persist: async () => {}, now: () => new Date('2026-10-09T13:00:00.000Z') });
    const score = scoreRoleReview(selected, hypotheticalAnnotations(selected), context); expect(score.coverage.reviewed).toBe(2);
    expect(score.byScenario[attempt.scenario.id].reviewed).toBe(1); expect(score.byScenario[other.scenario.id].reviewed).toBe(1);
    expect(score.byRole.coach.planned).toBe(0); expect(score.metrics.coach.rubricWithinOneBand.value).toBeNull();
  });
  it('imports through the actual zero-call CLI with private exclusive output and honest pending exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-role-review-')); directories.push(directory);
    const runPath = join(directory, 'hypothetical-run.json'), templatePath = join(directory, 'blank.json'), scorePath = join(directory, 'score.json'); await writeFile(runPath, JSON.stringify(run), { mode: 0o600 });
    const base = ['--conditions=react-server', '--import=tsx', 'scripts/review-role-models.ts', '--run', runPath];
    execFileSync(process.execPath, [...base, '--template', '--output', templatePath], { env: { ...process.env, OPENAI_API_KEY: '', OPENAI_MODEL: 'invalid-current-config', OPENAI_INPUT_USD_PER_MILLION: '' }, stdio: 'pipe' });
    const template = JSON.parse(await readFile(templatePath, 'utf8')); expect(template.cases.every((row: { reviews: unknown[] }) => row.reviews.length === 0)).toBe(true); expect((await stat(templatePath)).mode & 0o777).toBe(0o600);
    expect(() => execFileSync(process.execPath, [...base, '--template', '--output', templatePath], { stdio: 'pipe' })).toThrow();
    execFileSync(process.execPath, [...base, '--reviews', templatePath, '--output', scorePath], { stdio: 'pipe' }); expect(JSON.parse(await readFile(scorePath, 'utf8')).status).toBe('pending');
    expect(() => execFileSync(process.execPath, [...base, '--reviews', templatePath, '--require-complete'], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(process.execPath, [...base, '--record'], { stdio: 'pipe' })).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
});
