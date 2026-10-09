import { describe, expect, expectTypeOf, it } from 'vitest';
import { listScenarios } from '../lib/content/scenarios';
import { toPublicScenario } from '../lib/interview-practice/domain';
import { buildProgression } from '../lib/interview-practice/progression';
import type { CoachingReport, EvidenceItem, RubricLevel, SessionView } from '../lib/interview-practice/types';

const catalog = listScenarios().map(toPublicScenario);
const task = (id: string) => structuredClone(catalog.find(scenario => scenario.id === id)!);
const money = () => task('monetary-validation');
function attempt(id: string, scenario = money(), level: RubricLevel = 'Developing', observedAt = '2026-10-09T12:00:00.000Z'): SessionView {
  const evidence: EvidenceItem[] = [{ id: 'recorded-test', kind: 'test', label: 'Synthetic recorded test', content: '{"status":"failed"}', sha256: 'a'.repeat(64), source: 'executed-test' }];
  const report: CoachingReport = {
    id: `${id}-report`, generationId: `${id}-generation`, createdAt: observedAt, model: 'synthetic-fixture', promptVersion: 'fixture-v1',
    rubricVersion: scenario.version, evidenceDigest: 'b'.repeat(64), evidence,
    overview: 'Synthetic findings for deterministic policy tests, not provider evaluation.',
    rubric: scenario.rubric.map(criterion => ({ criterionId: criterion.id, level, feedback: 'Synthetic evidence-linked finding.', evidenceIds: level === 'Not observed' ? [] : ['recorded-test'], confidence: 'low' })),
    nextPractice: [{ drillId: scenario.drills[0].id, reason: 'Synthetic drill selection.' }],
  };
  return {
    id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'completed', stageId: 'debrief', revision: 1,
    configuration: { role: 'Backend engineer', level: scenario.level, skills: scenario.tags, targetMinutes: scenario.durationMinutes, aiHelp: true, accommodations: [] },
    files: scenario.files, codeFrozenSnapshotId: `${id}-snapshot`, frozenEvidence: { digest: report.evidenceDigest, watermark: 0, items: evidence, frozenAt: observedAt },
    events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [report],
    usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: observedAt, updatedAt: observedAt,
    hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh', evidence,
  };
}
function onlyGap(session: SessionView, criterionId: string, level: RubricLevel = 'Developing') {
  session.reports[0].rubric.forEach(finding => { finding.level = finding.criterionId === criterionId ? level : 'Strong'; });
  return session;
}
function corrected(session: SessionView, level: RubricLevel) {
  const original = session.reports[0], next = structuredClone(original);
  next.id = `${session.id}-correction`; next.createdAt = '2026-10-12T12:00:00.000Z'; next.model = 'staff-reviewed';
  next.correction = { sourceReportId: original.id, reason: 'Synthetic correction.', publishedAt: next.createdAt };
  next.rubric.forEach(finding => { finding.level = level; finding.evidenceIds = level === 'Not observed' ? [] : ['recorded-test']; });
  session.reports.push(next); session.updatedAt = next.createdAt; session.revision++;
  return session;
}

describe('deterministic skill profile evidence', () => {
  it('preserves the existing progress response fields while adding provenance', () => {
    const result = buildProgression([attempt('a')], catalog);
    const skill = result.skills[0], recommendation = result.recommendations[0];
    expect(skill).toMatchObject({ id: 'money-correctness', name: 'Exact monetary behavior', observations: 1, lastObservedAt: '2026-10-09T12:00:00.000Z', level: 'Developing', levels: { Developing: 1, 'Not observed': 0 } });
    expectTypeOf(skill.level).toExtend<RubricLevel>();
    expectTypeOf(skill.levels).toEqualTypeOf<Record<RubricLevel, number>>();
    expect(recommendation).toEqual(expect.objectContaining({ scenarioId: expect.any(String), title: expect.any(String), fresh: expect.any(Boolean), reason: expect.any(String) }));
  });

  it('counts only the latest published report and dates a correction at the original observation', () => {
    const session = corrected(attempt('a'), 'Strong');
    const result = buildProgression([session], catalog);
    expect(result.details).toMatchObject({ assessedAttempts: 1, originalReportsSuperseded: 1 });
    for (const skill of result.skills) {
      expect(skill).toMatchObject({ observations: 1, level: 'Strong', lastObservedAt: session.frozenEvidence!.frozenAt, levels: { Strong: 1, Developing: 0 } });
      expect(skill.history[0]).toMatchObject({ reportId: 'a-correction', corrected: true, assessmentSource: 'staff-reviewed' });
    }
  });

  it('uses publication order even if a correction has an earlier report timestamp', () => {
    const session = corrected(attempt('a'), 'Needs work');
    session.reports[1].createdAt = '2026-10-01T00:00:00Z';
    expect(buildProgression([session], catalog).skills.every(skill => skill.level === 'Needs work')).toBe(true);
  });

  it('does not turn Not observed into a negative finding or carry a superseded gap forward', () => {
    const result = buildProgression([corrected(attempt('a', money(), 'Needs work'), 'Not observed')], catalog);
    expect(result.skills).toEqual([]);
    expect(result.details.unobserved).toHaveLength(3);
    expect(result.details.unobserved.every(row => row.attempts === 1)).toBe(true);
    expect(result.recommendations.every(row => row.matchedCompetencyIds.length === 0)).toBe(true);
    expect(result.studyPlan.explanation).toContain('Missing observations are not weaknesses');
  });

  it('keeps a prior observation dated accurately when a later attempt did not observe the skill', () => {
    const earlier = attempt('a', money(), 'Developing', '2026-10-08T12:00:00Z');
    const later = attempt('b', money(), 'Not observed', '2026-10-09T12:00:00Z');
    const result = buildProgression([later, earlier], catalog);
    expect(result.skills[0]).toMatchObject({ observations: 1, lastObservedAt: earlier.frozenEvidence!.frozenAt, level: 'Developing' });
    expect(result.details.unobserved[0].lastAttemptAt).toBe(later.frozenEvidence!.frozenAt);
  });

  it('excludes findings with no supporting evidence, unknown references or unknown criteria', () => {
    const session = attempt('a');
    session.reports[0].rubric[0].evidenceIds = [];
    session.reports[0].rubric[1].evidenceIds = ['unknown-evidence'];
    session.reports[0].rubric.push({ ...session.reports[0].rubric[2], criterionId: 'unknown-criterion' });
    const result = buildProgression([session], catalog);
    expect(result.skills.map(skill => skill.id)).toEqual(['money-verification']);
    expect(result.details.ignoredFindings).toBe(3);
    expect(result.studyPlan.limitations.join(' ')).toContain('excluded');
  });

  it('does not count duplicate findings or duplicate attempt versions twice', () => {
    const original = attempt('a'), replacement = corrected(structuredClone(original), 'Strong');
    replacement.reports.at(-1)!.rubric.push(structuredClone(replacement.reports.at(-1)!.rubric[0]));
    const result = buildProgression([original, replacement, structuredClone(replacement)], catalog);
    expect(result.details).toMatchObject({ attempts: 1, assessedAttempts: 1, ignoredFindings: 1 });
    expect(result.skills.every(skill => skill.observations === 1 && skill.level === 'Strong')).toBe(true);
  });

  it('counts unique evidence references per attempt, not rubric mentions or report generations', () => {
    const result = buildProgression([corrected(attempt('a'), 'Strong'), attempt('b', money(), 'Strong', '2026-10-10T12:00:00Z')], catalog);
    expect(result.details.evidenceCount).toBe(2);
    expect(result.skills.every(skill => skill.evidenceCount === 2 && skill.observations === 2)).toBe(true);
  });

  it('ignores report-like artifacts on unfinished attempts', () => {
    const session = attempt('a'); session.lifecycle = 'reviewing';
    const result = buildProgression([session], catalog);
    expect(result.skills).toEqual([]);
    expect(result.details).toMatchObject({ attempts: 1, completedAttempts: 0, assessedAttempts: 0 });
    expect(result.recommendations.find(row => row.scenarioId === session.scenarioId)?.fresh).toBe(false);
  });

  it('orders actual observation times rather than recent administrative updates', () => {
    const older = attempt('a', money(), 'Needs work', '2026-10-08T12:00:00Z'); older.updatedAt = '2026-10-12T12:00:00Z';
    const newer = attempt('b', money(), 'Strong', '2026-10-09T13:00:00+01:00');
    expect(buildProgression([newer, older], catalog).skills[0]).toMatchObject({ level: 'Strong', lastObservedAt: newer.frozenEvidence!.frozenAt });
  });
});

describe('freshness, assistance and comparable attempts', () => {
  it('preserves stored repeated exposure after prior history has been deleted', () => {
    const session = attempt('a'); session.promptExposure = 'repeated';
    const skill = buildProgression([session], catalog).skills[0];
    expect(skill).toMatchObject({ freshObservations: 0, repeatedObservations: 1, evidenceStatus: 'limited' });
  });

  it('conservatively marks a later same-scenario attempt repeated, including a new scenario version', () => {
    const first = attempt('a', money(), 'Developing', '2026-10-08T12:00:00Z');
    const second = attempt('b', money(), 'Strong', '2026-10-09T12:00:00Z');
    second.scenarioVersion = '2.0.0'; second.scenario.version = '2.0.0';
    const skill = buildProgression([second, first], catalog).skills[0];
    expect(skill).toMatchObject({ freshObservations: 1, repeatedObservations: 1, evidenceStatus: 'limited' });
    expect(skill.history[1].conditions.exposure).toBe('repeated');
  });

  it('records help received separately from permission without penalizing findings or accessibility', () => {
    const unassisted = attempt('a'), assisted = structuredClone(unassisted);
    assisted.assistantMessages.push({ id: 'assistant-1', role: 'assistant', text: 'Synthetic assistance', createdAt: assisted.createdAt });
    assisted.hintsOpened = 2; assisted.configuration.accommodations = ['Text interaction', 'Additional time'];
    const before = buildProgression([unassisted], catalog), after = buildProgression([assisted], catalog);
    expect(before.skills[0].history[0].conditions).toMatchObject({ aiHelpAllowed: true, helpReceived: false });
    expect(after.skills[0].history[0].conditions).toMatchObject({ aiHelpAllowed: true, assistantResponses: 1, hintsOpened: 2, helpReceived: true, accommodationCount: 2 });
    expect(after.skills.map(skill => skill.level)).toEqual(before.skills.map(skill => skill.level));
    expect(after.recommendations).toEqual(before.recommendations);
    expect(after.details.evidencePolicy.assistancePenalty).toBe(false);
  });

  it('does not label an unanswered or failed assistant request as received help', () => {
    const session = attempt('a'); session.assistantMessages.push({ id: 'ask-1', role: 'learner', text: 'Please help', createdAt: session.createdAt });
    expect(buildProgression([session], catalog).skills[0].history[0].conditions).toMatchObject({ assistantRequests: 1, assistantResponses: 0, helpReceived: false });
  });

  it('keeps changes in versions, simulation mode and help conditions in distinct groups', () => {
    const first = attempt('a', money(), 'Developing', '2026-10-08T12:00:00Z');
    const second = attempt('b', money(), 'Strong', '2026-10-09T12:00:00Z'); second.mode = 'simulation'; second.configuration.aiHelp = false;
    const skill = buildProgression([first, second], catalog).skills[0];
    expect(skill.consistency).toMatchObject({ status: 'conditions-vary' });
    expect(skill.consistency.groups).toHaveLength(2);
    expect(skill.levels).toMatchObject({ Developing: 1, Strong: 1 });
    expect(skill).not.toHaveProperty('score'); expect(skill).not.toHaveProperty('mastery');
  });

  it('reports repeated findings under comparable conditions without a mastery claim', () => {
    const first = attempt('a', money(), 'Strong', '2026-10-08T12:00:00Z'); first.promptExposure = 'repeated';
    const second = attempt('b', money(), 'Strong', '2026-10-09T12:00:00Z'); second.promptExposure = 'repeated';
    const skill = buildProgression([first, second], catalog).skills[0];
    expect(skill.consistency.status).toBe('consistent-findings');
    expect(skill.evidenceStatus).toBe('limited');
    expect(skill.limitations.join(' ')).toContain('transfer remains unobserved');
  });

  it('requires two distinct fresh tasks on the exact criterion for broader coverage', () => {
    const secondTask = money(); secondTask.id = 'independent-fixture';
    const result = buildProgression([attempt('a', money(), 'Strong', '2026-10-08T12:00:00Z'), attempt('b', secondTask, 'Strong')], [money(), secondTask]);
    expect(result.skills[0]).toMatchObject({ evidenceStatus: 'multiple-fresh-task-observations', distinctScenarios: 2, freshObservations: 2 });
    expect(result.skills[0].limitations.join(' ')).toContain('provisional');
    expect(result.details.evidencePolicy.freshDistinctTasksForBroaderCoverage).toBe(2);
  });
});

describe('bounded deterministic study planning', () => {
  it('starts cold with selected competencies and never invents a weakness', () => {
    const result = buildProgression([], catalog, { selectedCompetencies: ['concurrency-atomicity'] });
    expect(result.skills).toEqual([]); expect(result.studyPlan.status).toBe('cold-start');
    expect(result.recommendations[0]).toMatchObject({ scenarioId: 'inventory-reservations', fresh: true, matchingBasis: 'selected-goal', matchedCompetencyIds: [] });
    expect(result.studyPlan.steps[0]).toMatchObject({ kind: 'scenario', scenarioId: 'inventory-reservations' });
    expect(result.studyPlan.explanation).toContain('no weakness is inferred');
  });

  it('prefers an unseen related task over repeats and unrelated unseen tasks', () => {
    const session = onlyGap(attempt('a'), 'money-validation', 'Needs work');
    const result = buildProgression([session], catalog);
    expect(result.recommendations[0]).toMatchObject({ scenarioId: 'duplicate-invoice', fresh: true, matchingBasis: 'authored-transfer-map', matchedCompetencyIds: ['money-validation'] });
    expect(result.recommendations[0].reason).toContain('rubric levels are not interchangeable');
    expect(result.studyPlan.steps).toHaveLength(3);
    expect(result.studyPlan.steps.map(step => step.kind)).toEqual(['scenario', 'drill', 'lesson']);
    expect(result.skills.some(skill => skill.id === 'input-validation')).toBe(false);
  });

  it('uses frozen original rubric and drills rather than reinterpreting an old attempt with new catalog content', () => {
    const original = onlyGap(attempt('a'), 'money-correctness'), changed = money();
    changed.version = '2.0.0'; changed.rubric[0].name = 'Changed criterion'; changed.drills[0].exercise = 'CHANGED-EXERCISE';
    const result = buildProgression([original], [changed]);
    expect(result.skills[0].name).toBe('Exact monetary behavior');
    expect(result.recommendations[0]).toMatchObject({ version: '2.0.0', fresh: false });
    const drill = result.studyPlan.steps.find(step => step.kind === 'drill');
    expect(drill).toMatchObject({ scenarioVersion: '1.0.0', exercise: original.scenario.drills[0].exercise });
  });

  it('reports a missing fresh transfer task instead of claiming an unrelated task validates the gap', () => {
    const result = buildProgression([onlyGap(attempt('a'), 'money-correctness')], catalog);
    expect(result.details.gapsWithoutFreshTask).toContain('money-correctness');
    expect(result.studyPlan.status).toBe('catalog-limited');
    expect(result.studyPlan.explanation).toContain('transfer cannot yet be checked');
  });

  it('handles an exhausted catalog and self-reported drills without adding observations', () => {
    const sessions = catalog.map((scenario, index) => attempt(`attempt-${index}`, scenario));
    sessions.forEach(session => { session.completedDrillIds = session.scenario.drills.map(drill => drill.id); });
    const result = buildProgression(sessions, catalog);
    expect(result.recommendations.every(item => !item.fresh)).toBe(true);
    expect(result.studyPlan).toMatchObject({ status: 'catalog-limited' });
    expect(result.studyPlan.steps.length).toBeLessThanOrEqual(3);
    expect(result.studyPlan.steps.find(step => step.kind === 'drill')).toMatchObject({ completedSelfReport: true });
    expect(result.studyPlan.steps.find(step => step.kind === 'scenario')?.reason).toContain('cannot establish fresh-task transfer');
    expect(result.skills.every(skill => skill.observations === 1)).toBe(true);
    expect(result.details.evidencePolicy.drillCompletion).toBe('learner-self-report');
  });

  it('handles an empty catalog without inventing a task or a live Foundry URL', () => {
    const result = buildProgression([onlyGap(attempt('a'), 'money-validation')], []);
    expect(result.recommendations).toEqual([]); expect(result.studyPlan.status).toBe('catalog-limited');
    expect(result.studyPlan.steps.map(step => step.kind)).toEqual(['drill', 'lesson']);
    const lesson = result.studyPlan.steps.find(step => step.kind === 'lesson');
    expect(lesson).toMatchObject({ foundryPath: '/low-level-design/lessons/state-lifecycle-errors', requiresFoundryIntegration: true });
    expect(lesson).not.toHaveProperty('href');
    expect(JSON.stringify(result)).not.toContain('https://');
    expect(buildProgression([], []).studyPlan.steps).toEqual([]);
  });

  it('reports unsupported goals and accepts exact authored criterion IDs', () => {
    const unknown = buildProgression([], catalog, { selectedCompetencies: ['unpublished-skill', 'unpublished-skill'] });
    expect(unknown.details.unresolvedGoals).toEqual(['unpublished-skill']);
    expect(unknown.recommendations.every(item => item.matchedGoalIds.length === 0)).toBe(true);
    const known = buildProgression([], catalog, { selectedCompetencies: ['stock-atomicity'] });
    expect(known.recommendations[0].scenarioId).toBe('inventory-reservations');
  });

  it('treats prototype property names as unmapped goals rather than transfer data', () => {
    const result = buildProgression([], catalog, { selectedCompetencies: ['constructor', '__proto__', 'toString'] });
    expect(result.details.unresolvedGoals).toEqual(['__proto__', 'constructor', 'toString']);
    expect(result.recommendations.every(item => item.matchedGoalIds.length === 0)).toBe(true);
  });

  it('selects the latest catalog version without declaring a new version fresh', () => {
    const older = money(), newer = money(); older.version = '2.0.0'; newer.version = '10.0.0';
    const result = buildProgression([attempt('a')], [older, newer]);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({ version: '10.0.0', fresh: false });
  });

  it('returns identical results for reordered inputs and does not mutate caller data', () => {
    const sessions = [attempt('a', money(), 'Developing', '2026-10-08T12:00:00Z'), attempt('b', task('event-rollup'), 'Needs work')];
    const before = JSON.stringify({ sessions, catalog });
    const goals = { selectedCompetencies: ['verification', 'input-validation'] };
    expect(buildProgression(sessions, catalog, goals)).toEqual(buildProgression([...sessions].reverse(), [...catalog].reverse(), { selectedCompetencies: [...goals.selectedCompetencies].reverse() }));
    expect(JSON.stringify({ sessions, catalog })).toBe(before);
  });
});
