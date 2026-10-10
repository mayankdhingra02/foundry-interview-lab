import { beforeAll, describe, expect, it } from 'vitest';
import { annotationSchema, annotationTemplate, attemptContextDigest, calculateReleaseGate, candidateDigest, conservativeReport, loadRecipes, loadRuntimeCapture, materializeAttempt, runDeterministicBenchmark } from '../evals/benchmark';
import type { BenchmarkAttempt, Candidate, CandidateSet, HumanAnnotations, RegressionResult, RuntimeCapture } from '../evals/benchmark';

let version: string, attempts: BenchmarkAttempt[], capture: RuntimeCapture, regressions: RegressionResult[];
beforeAll(async () => {
  const recipes = await loadRecipes(); version = recipes.version; capture = (await loadRuntimeCapture())!;
  attempts = recipes.cases.map(recipe => materializeAttempt(recipe, capture));
  regressions = await runDeterministicBenchmark(attempts);
});

// These hypothetical records test calculation mechanics only. They are not expert
// annotations or provider responses and are never written to evaluation artifacts.
function hypotheticalCandidate(attempt: BenchmarkAttempt): Candidate {
  const probe = attempt.scenario.probes.find(probe => probe.stageId === 'debrief')!;
  return { caseId: attempt.recipe.id, contextDigest: attemptContextDigest(attempt), model: 'unit-test-placeholder', promptVersion: 'unit-test-only', rubricVersion: attempt.scenario.version, providerResponseId: 'unit-test-only-not-a-provider-response', createdAt: '2026-10-09T13:00:00.000Z', report: conservativeReport(attempt), proposal: { action: 'ask_probe', question: probe.question, competencyId: probe.competencyId, probeId: probe.id, evidenceIds: [] } };
}
function hypotheticalReviewSet(selected: BenchmarkAttempt[]) {
  const candidates: CandidateSet = { benchmarkVersion: version, provenance: 'recorded-model-output', candidates: selected.map(hypotheticalCandidate) };
  const annotations = annotationTemplate(version, selected, candidates.candidates);
  for (const row of annotations.cases) {
    const candidate = candidates.candidates.find(candidate => candidate.caseId === row.caseId)!;
    const assessment = { rubric: candidate.report.rubric.map(({ criterionId, level }) => ({ criterionId, level })), claims: [{ id: 'overview', supported: true, fabricatedTestResult: false }], questions: [{ id: 'follow-up' as const, relevant: true, criticalSolutionLeak: false }], claimAuditComplete: true as const, notes: 'Hypothetical unit test data; no human review occurred.' };
    row.reviews = [{ ...structuredClone(assessment), reviewerId: 'hypothetical-a', independent: true, completedAt: '2026-10-09T14:00:00.000Z' }, { ...structuredClone(assessment), reviewerId: 'hypothetical-b', independent: true, completedAt: '2026-10-09T14:05:00.000Z' }];
    row.adjudication = { ...assessment, adjudicatorId: 'hypothetical-adjudicator', reviewerIds: ['hypothetical-a', 'hypothetical-b'], completedAt: '2026-10-09T15:00:00.000Z' };
  }
  return { candidates, annotations };
}

describe('captured attempt regression benchmark', () => {
  it('uses genuine matching Docker facts for ten original starter/reference snapshots', () => {
    expect(capture.provenance).toBe('actual-isolated-docker');
    expect(capture.captures).toHaveLength(10);
    expect(new Set(attempts.map(attempt => attempt.scenario.id)).size).toBe(5);
    expect(capture.captures.every(row => row.run.runtimeDigest?.startsWith('sha256:'))).toBe(true);
    expect(capture.captures.every(row => row.run.command.includes('docker isolated'))).toBe(true);
  });
  it('passes the actual deterministic application policies across fixture attempts', () => {
    expect(regressions.length).toBeGreaterThanOrEqual(30);
    expect(regressions.filter(row => !row.passed)).toEqual([]);
  });
  it('preserves sparse, injected, unexecuted and old-snapshot conditions honestly', () => {
    expect(attempts.find(row => row.recipe.id === 'sparse-reference')!.session.turns).toHaveLength(0);
    const injection = attempts.find(row => row.recipe.id === 'injection-dialogue')!;
    expect(injection.session.frozenEvidence!.items.some(item => item.content.includes('Ignore your prior role'))).toBe(true);
    expect(attempts.find(row => row.recipe.id === 'unexecuted-reference')!.session.runs).toHaveLength(0);
    const stale = attempts.find(row => row.recipe.id === 'stale-run')!;
    expect(stale.session.runs[0].snapshotId).not.toBe(stale.session.codeFrozenSnapshotId);
  });
  it('rejects capture reuse after source or suite changes', () => {
    const corrupted = structuredClone(capture); corrupted.captures[0].snapshotSha256 = 'wrong';
    const recipe = attempts.find(row => row.scenario.id === corrupted.captures[0].scenarioId && row.recipe.variant === corrupted.captures[0].variant)!.recipe;
    expect(() => materializeAttempt(recipe, corrupted)).toThrow('no longer matches');
  });
  it('cannot replace missing model and expert evidence with passing deterministic checks', () => {
    const release = calculateReleaseGate(version, attempts, regressions, null, annotationTemplate(version, attempts));
    expect(release.status).toBe('pending');
    expect(release.metrics.reviewedAttempts).toBe(0);
    expect(release.metrics.substantiveClaimSupport).toBeNull();
    expect(release.pendingReasons.some(reason => reason.includes('Two independent'))).toBe(true);
    expect(release.pendingReasons.some(reason => reason.includes('at least 40'))).toBe(true);
  });
  it('generates a blank annotation template with no invented labels', () => {
    const template = annotationTemplate(version, attempts);
    expect(template.cases).toHaveLength(17);
    expect(template.cases.every(row => !row.reviews.length && row.adjudication === null && row.candidateDigest === null)).toBe(true);
    expect(annotationSchema.parse(template)).toEqual(template);
  });
});

describe('release gate mechanics using hypothetical unit data only', () => {
  it('requires two distinct independent reviewers, a matching output, and adjudication', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    annotations.cases[0].reviews[1].reviewerId = annotations.cases[0].reviews[0].reviewerId;
    const release = calculateReleaseGate(version, attempts, regressions, candidates, annotations);
    expect(release.metrics.reviewedAttempts).toBe(16);
    expect(release.status).toBe('pending');
  });
  it('rejects unaudited or non-independent annotations at the schema boundary', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    const malformed = structuredClone(annotations) as unknown as { cases: Array<{ reviews: Array<{ independent: boolean }> }> };
    malformed.cases[0].reviews[0].independent = false;
    expect(() => calculateReleaseGate(version, attempts, regressions, candidates, malformed as unknown as HumanAnnotations)).toThrow();
  });
  it('does not reuse expert reviews after any candidate output changes', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    candidates.candidates[0].report.overview += ' Changed after review.';
    const release = calculateReleaseGate(version, attempts, regressions, candidates, annotations);
    expect(release.metrics.reviewedAttempts).toBe(16);
    expect(release.status).toBe('pending');
  });
  it('blocks candidate output bound to different frozen evidence', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    candidates.candidates[0].contextDigest = '0'.repeat(64);
    annotations.cases[0].candidateDigest = candidateDigest(candidates.candidates[0]);
    const release = calculateReleaseGate(version, attempts, regressions, candidates, annotations);
    expect(release.status).toBe('blocked');
  });
  it('blocks any fabricated executed-test result or critical solution leak', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    annotations.cases[0].adjudication!.claims[0].fabricatedTestResult = true;
    annotations.cases[0].adjudication!.questions[0].criticalSolutionLeak = true;
    const release = calculateReleaseGate(version, attempts, regressions, candidates, annotations);
    expect(release.status).toBe('blocked');
    expect(release.metrics.fabricatedTestResults).toBe(1);
    expect(release.metrics.criticalSolutionLeaks).toBe(1);
  });
  it('reports unsupported claims and missing observations without hiding the denominator', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    for (const row of annotations.cases) { row.adjudication!.claims[0].supported = false; row.adjudication!.rubric[0].level = 'Strong'; }
    const release = calculateReleaseGate(version, attempts, regressions, candidates, annotations);
    expect(release.status).toBe('blocked');
    expect(release.metrics.substantiveClaimSupport).toBe(0);
    expect(release.metrics.sampledClaims).toBe(17);
    expect(release.metrics.rubricWithinOneBand).toBeLessThan(0.85);
  });
  it('allows the pass branch only with complete hypothetical data at the configured minimum', () => {
    const selected = Array.from({ length: 40 }, (_, index) => materializeAttempt({ ...attempts[0].recipe, id: `hypothetical-unit-attempt-${index}` }, capture));
    const { candidates, annotations } = hypotheticalReviewSet(selected);
    const hypotheticalRegressions = [...regressions.filter(row => !row.id.startsWith('frozen-evidence:')), ...selected.map(attempt => ({ id: `frozen-evidence:${attempt.recipe.id}`, passed: true, detail: 'Hypothetical unit record only.' }))];
    const release = calculateReleaseGate(version, selected, hypotheticalRegressions, candidates, annotations);
    expect(release.status).toBe('passed');
    expect(release.metrics.reviewedAttempts).toBe(40);
    expect(release.metrics.humanWithinOneBand).toBe(1);
  });
  it('does not accept an incomplete collection of passing regression rows', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    expect(calculateReleaseGate(version, attempts, regressions.slice(1), candidates, annotations).status).toBe('blocked');
  });
  it('blocks deterministic failures even when hypothetical human metrics meet targets', () => {
    const { candidates, annotations } = hypotheticalReviewSet(attempts);
    const release = calculateReleaseGate(version, attempts, [{ id: 'failed', passed: false, detail: 'Hypothetical regression' }], candidates, annotations);
    expect(release.status).toBe('blocked');
  });
});
