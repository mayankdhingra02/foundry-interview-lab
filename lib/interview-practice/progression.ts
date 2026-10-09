import type { CoachingFinding, PublicScenario, RubricLevel, SessionView } from './types';

type ObservedLevel = Exclude<RubricLevel, 'Not observed'>;
export type ProgressionGoals = { selectedCompetencies?: string[] };
export type PracticeConditions = {
  exposure: 'fresh' | 'repeated'; mode: SessionView['mode']; aiHelpAllowed: boolean;
  assistantRequests: number; assistantResponses: number; acceptedEdits: number;
  hintsOpened: number; helpReceived: boolean; accommodationCount: number;
};
export type SkillObservation = {
  sessionId: string; scenarioId: string; scenarioVersion: string; rubricVersion: string;
  reportId: string; corrected: boolean; observedAt: string; level: ObservedLevel;
  assessmentSource: 'staff-reviewed' | 'authored' | 'model'; model: string; promptVersion: string;
  confidence: CoachingFinding['confidence']; evidenceIds: string[]; conditions: PracticeConditions;
};
export type SkillProgress = {
  // These six fields preserve the existing /progress response.
  id: string; name: string; observations: number; lastObservedAt: string;
  level: ObservedLevel; levels: Record<RubricLevel, number>;
  evidenceCount: number; freshObservations: number; repeatedObservations: number;
  distinctScenarios: number; helpReceivedObservations: number; history: SkillObservation[];
  evidenceStatus: 'limited' | 'multiple-fresh-task-observations'; limitations: string[];
  consistency: { status: 'single-observation' | 'conditions-vary' | 'consistent-findings' | 'mixed-findings'; groups: Array<{ key: string; attemptIds: string[]; levels: Record<RubricLevel, number> }> };
};
export type PracticeRecommendation = {
  scenarioId: string; title: string; fresh: boolean; reason: string;
  version: string; href: string; durationMinutes: number; matchedCompetencyIds: string[];
  matchedGoalIds: string[]; matchingBasis: 'same-criterion' | 'authored-transfer-map' | 'selected-goal' | 'catalog-exploration';
};
export type FoundryLessonReference = {
  id: string; title: string; foundryPath: string; estimatedMinutes: number;
  competencies: string[]; verifiedFrom: 'main-foundry-source'; verifiedAt: '2026-10-09';
  requiresFoundryIntegration: true;
};
export type StudyStep =
  | { kind: 'scenario'; id: string; title: string; reason: string; href: string; scenarioId: string; version: string; fresh: boolean; competencyIds: string[]; estimatedMinutes: number }
  | { kind: 'drill'; id: string; title: string; reason: string; href: string; sessionId: string; scenarioId: string; scenarioVersion: string; drillId: string; competencyIds: string[]; lesson: string; exercise: string; completedSelfReport: boolean }
  | { kind: 'lesson'; id: string; title: string; reason: string; foundryPath: string; competencyIds: string[]; estimatedMinutes: number; requiresFoundryIntegration: true };
export type ProgressionResult = {
  skills: SkillProgress[]; recommendations: PracticeRecommendation[];
  studyPlan: { policyVersion: 'deterministic-v1'; status: 'cold-start' | 'provisional' | 'catalog-limited'; selectedCompetencies: string[]; steps: StudyStep[]; explanation: string; limitations: string[]; foundryLessons: FoundryLessonReference[] };
  details: {
    attempts: number; completedAttempts: number; assessedAttempts: number; originalReportsSuperseded: number;
    evidenceCount: number; ignoredFindings: number; unobserved: Array<{ id: string; name: string; attempts: number; lastAttemptAt: string }>;
    unresolvedGoals: string[]; gapsWithoutFreshTask: string[];
    evidencePolicy: { freshDistinctTasksForBroaderCoverage: 2; findingsPerAttemptPerCriterion: 1; assistancePenalty: false; drillCompletion: 'learner-self-report' };
  };
};

// Editorial transfer suggestions, not claims that these scenario-specific
// rubrics measure an identical scale. Skill histories keep the original IDs.
const transfer: Record<string, readonly string[]> = {
  'money-correctness': ['exact-money', 'contract-reasoning'],
  'money-validation': ['input-validation'], 'money-verification': ['verification'],
  'invoice-identity': ['retry-idempotency'], 'invoice-conflicts': ['input-validation', 'failure-semantics'],
  'invoice-verification': ['verification', 'retry-idempotency'],
  'stock-atomicity': ['concurrency-atomicity'], 'stock-consistency': ['failure-semantics', 'state-invariants'],
  'stock-verification': ['verification', 'concurrency-atomicity'],
  'rollup-comprehension': ['repository-comprehension'], 'rollup-correctness': ['retry-idempotency', 'failure-semantics'],
  'rollup-verification': ['verification'], 'export-compatibility': ['interface-compatibility'],
  'export-extension': ['interface-compatibility', 'responsibility-boundaries'], 'export-verification': ['verification'],
};
const lesson = (id: string, title: string, foundryPath: string, estimatedMinutes: number, competencies: string[]): FoundryLessonReference => ({ id, title, foundryPath, estimatedMinutes, competencies, verifiedFrom: 'main-foundry-source', verifiedAt: '2026-10-09', requiresFoundryIntegration: true });
const lessons: FoundryLessonReference[] = [
  lesson('correctness', 'Correctness: explain why the algorithm must work', '/dsa/foundations/correctness', 20, ['verification', 'contract-reasoning']),
  lesson('state-lifecycle-errors', 'Model state, lifecycle, invariants, and errors', '/low-level-design/lessons/state-lifecycle-errors', 22, ['input-validation', 'failure-semantics', 'state-invariants', 'retry-idempotency']),
  lesson('concurrency-testability-evolution', 'Design for concurrency, testability, and evolving requirements', '/low-level-design/lessons/concurrency-testability-evolution', 24, ['concurrency-atomicity']),
  lesson('relationships-interfaces', 'Design relationships and interfaces that carry behavior', '/low-level-design/lessons/relationships-interfaces', 19, ['interface-compatibility']),
  lesson('responsibilities-ownership', 'Assign responsibilities and ownership', '/low-level-design/lessons/responsibilities-ownership', 20, ['repository-comprehension', 'responsibility-boundaries']),
];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const compareTime = (a: string, b: string) => Date.parse(a) - Date.parse(b) || compare(a, b);
const unique = (values: string[]) => [...new Set(values)].sort(compare);
const competencies = (id: string) => new Set([id, ...(Object.hasOwn(transfer, id) ? transfer[id] : [])]);
const overlap = (a: Set<string>, b: Set<string>) => [...a].some(value => b.has(value));
const levels = (): Record<RubricLevel, number> => ({ Strong: 0, Developing: 0, 'Needs work': 0, 'Not observed': 0 });
const rank = (level: ObservedLevel) => level === 'Needs work' ? 0 : level === 'Developing' ? 1 : 2;
function versionCompare(a: string, b: string) {
  return a.localeCompare(b, 'en', { numeric: true }) || compare(a, b);
}
function attemptsOnce(sessions: SessionView[]) {
  const rows = new Map<string, SessionView>();
  for (const session of sessions) {
    const previous = rows.get(session.id);
    if (!previous || session.revision > previous.revision || (session.revision === previous.revision && compareTime(session.updatedAt, previous.updatedAt) > 0)) rows.set(session.id, session);
  }
  return [...rows.values()].sort((a, b) => compareTime(a.createdAt, b.createdAt) || compare(a.id, b.id));
}
function conditions(session: SessionView, seen: Set<string>): PracticeConditions {
  const assistantRequests = session.assistantMessages.filter(message => message.role === 'learner').length;
  const assistantResponses = session.assistantMessages.filter(message => message.role === 'assistant').length;
  const acceptedEdits = session.editProposals.filter(proposal => proposal.status === 'accepted').length;
  return {
    exposure: session.promptExposure === 'repeated' || seen.has(session.scenarioId) ? 'repeated' : 'fresh',
    mode: session.mode, aiHelpAllowed: session.configuration.aiHelp,
    assistantRequests, assistantResponses, acceptedEdits, hintsOpened: session.hintsOpened,
    helpReceived: assistantResponses > 0 || acceptedEdits > 0 || session.hintsOpened > 0,
    accommodationCount: session.configuration.accommodations.length,
  };
}
function groupKey(observation: SkillObservation) {
  const c = observation.conditions;
  return JSON.stringify([observation.scenarioId, observation.scenarioVersion, observation.rubricVersion, observation.model, observation.promptVersion, c.mode, c.exposure, c.aiHelpAllowed, c.assistantResponses > 0, c.acceptedEdits > 0, c.hintsOpened > 0]);
}

/** Pure, provider-free planning. Pass only this actor's authorized session views. */
export function buildProgression(sessions: SessionView[], catalog: PublicScenario[], goals: ProgressionGoals = {}): ProgressionResult {
  const attempts = attemptsOnce(sessions), byId = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const rows = new Map<string, { name: string; history: SkillObservation[] }>();
  const unobserved = new Map<string, { id: string; name: string; attempts: number; lastAttemptAt: string }>();
  const seen = new Set<string>(), evidence = new Set<string>();
  let assessedAttempts = 0, originalReportsSuperseded = 0, ignoredFindings = 0;
  for (const session of attempts) {
    const context = conditions(session, seen); seen.add(session.scenarioId);
    // Array order is publication order. A correction supersedes its original
    // without introducing a new learner attempt or a new observation date.
    const report = session.reports.at(-1);
    if (session.lifecycle !== 'completed' || !report) continue;
    assessedAttempts++; originalReportsSuperseded += session.reports.length - 1;
    const observedAt = session.frozenEvidence?.frozenAt ?? session.events.find(event => event.type === 'session.submitted')?.occurredAt ?? session.reports[0].createdAt;
    const evidenceIds = new Set(report.evidence.map(item => item.id));
    const counted = new Set<string>();
    for (const finding of report.rubric) {
      const criterion = session.scenario.rubric.find(item => item.id === finding.criterionId);
      if (!criterion || counted.has(finding.criterionId)) { ignoredFindings++; continue; }
      counted.add(finding.criterionId);
      if (finding.level === 'Not observed') {
        const row = unobserved.get(criterion.id) ?? { id: criterion.id, name: criterion.name, attempts: 0, lastAttemptAt: observedAt };
        row.attempts++; if (compareTime(observedAt, row.lastAttemptAt) > 0) row.lastAttemptAt = observedAt;
        unobserved.set(criterion.id, row); continue;
      }
      if (!finding.evidenceIds.length || new Set(finding.evidenceIds).size !== finding.evidenceIds.length || finding.evidenceIds.some(id => !evidenceIds.has(id))) { ignoredFindings++; continue; }
      const observation: SkillObservation = {
        sessionId: session.id, scenarioId: session.scenarioId, scenarioVersion: session.scenarioVersion,
        rubricVersion: report.rubricVersion, reportId: report.id, corrected: Boolean(report.correction), observedAt,
        assessmentSource: report.model === 'staff-reviewed' ? 'staff-reviewed' : report.model.startsWith('authored') || report.model.includes('deterministic') ? 'authored' : 'model', model: report.model, promptVersion: report.promptVersion,
        level: finding.level, confidence: finding.confidence, evidenceIds: [...finding.evidenceIds].sort(compare), conditions: { ...context },
      };
      const row = rows.get(criterion.id) ?? { name: criterion.name, history: [] };
      row.history.push(observation); rows.set(criterion.id, row);
      for (const id of finding.evidenceIds) evidence.add(`${session.id}:${id}`);
    }
  }
  const skills: SkillProgress[] = [...rows].map(([id, row]) => {
    const history = row.history.sort((a, b) => compareTime(a.observedAt, b.observedAt) || compare(a.sessionId, b.sessionId));
    const latest = history.at(-1)!, counts = levels(), references = new Set<string>();
    const groups = new Map<string, { key: string; attemptIds: string[]; levels: Record<RubricLevel, number> }>();
    for (const observation of history) {
      counts[observation.level]++;
      observation.evidenceIds.forEach(reference => references.add(`${observation.sessionId}:${reference}`));
      const key = groupKey(observation), group = groups.get(key) ?? { key, attemptIds: [], levels: levels() };
      group.attemptIds.push(observation.sessionId); group.levels[observation.level]++; groups.set(key, group);
    }
    const fresh = history.filter(observation => observation.conditions.exposure === 'fresh');
    const broaderCoverage = new Set(fresh.map(observation => observation.scenarioId)).size >= 2;
    return {
      id, name: row.name, observations: history.length, lastObservedAt: latest.observedAt, level: latest.level, levels: counts,
      evidenceCount: references.size, freshObservations: fresh.length, repeatedObservations: history.length - fresh.length,
      distinctScenarios: new Set(history.map(observation => observation.scenarioId)).size,
      helpReceivedObservations: history.filter(observation => observation.conditions.helpReceived).length, history,
      evidenceStatus: broaderCoverage ? 'multiple-fresh-task-observations' as const : 'limited' as const,
      limitations: [broaderCoverage ? 'Findings remain provisional across the observed tasks.' : 'Fewer than two fresh tasks assess this exact criterion; transfer remains unobserved.', 'Finding levels are descriptions, not a mastery score or interview pass probability.', 'Help and accessibility conditions are recorded without score penalties.'],
      consistency: {
        status: history.length === 1 ? 'single-observation' as const : groups.size > 1 ? 'conditions-vary' as const : new Set(history.map(observation => observation.level)).size === 1 ? 'consistent-findings' as const : 'mixed-findings' as const,
        groups: [...groups.values()].sort((a, b) => compare(a.key, b.key)),
      },
    };
  }).sort((a, b) => compare(a.id, b.id));
  const selected = unique((goals.selectedCompetencies ?? []).filter(id => typeof id === 'string' && id.length > 0));
  const selectedTags = new Set(selected.flatMap(id => [...competencies(id)]));
  const gaps = skills.filter(skill => skill.level === 'Needs work' || skill.level === 'Developing')
    .sort((a, b) => Number(overlap(competencies(b.id), selectedTags)) - Number(overlap(competencies(a.id), selectedTags)) || rank(a.level) - rank(b.level) || compareTime(b.lastObservedAt, a.lastObservedAt) || compare(a.id, b.id));
  const published = new Map<string, PublicScenario>();
  for (const scenario of catalog) {
    const prior = published.get(scenario.id);
    if (!prior || versionCompare(scenario.version, prior.version) > 0) published.set(scenario.id, scenario);
  }
  const recommendations: PracticeRecommendation[] = [...published.values()].map(scenario => {
    const tags = new Set(scenario.rubric.flatMap(criterion => [...competencies(criterion.id)]));
    const matching = gaps.filter(gap => overlap(competencies(gap.id), tags));
    const matchingGoals = selected.filter(goal => overlap(competencies(goal), tags));
    const exact = matching.some(gap => scenario.rubric.some(criterion => criterion.id === gap.id));
    const fresh = !seen.has(scenario.id);
    const reason = matching.length ? `${fresh ? 'An unseen task' : 'Deliberate repeat practice'} covering ${matching.map(skill => skill.name).join(', ')}. The latest recorded finding${matching.length === 1 ? ' is' : 's are'} ${matching.map(skill => skill.level).join(', ')}.${exact ? '' : ' Related-task matching uses the authored transfer map; rubric levels are not interchangeable.'}`
      : matchingGoals.length ? `${fresh ? 'An unseen task' : 'A deliberate repeat'} aligned with your selected competencies; no observed gap is inferred from that choice.`
      : fresh ? 'An unseen scenario to collect practice evidence; no specific weakness is inferred.' : 'Repeat for deliberate practice; familiarity remains recorded.';
    return { scenarioId: scenario.id, version: scenario.version, title: scenario.title, fresh, reason, href: `/interview-practice?scenario=${encodeURIComponent(scenario.id)}`, durationMinutes: scenario.durationMinutes, matchedCompetencyIds: matching.map(skill => skill.id), matchedGoalIds: matchingGoals, matchingBasis: matching.length ? exact ? 'same-criterion' as const : 'authored-transfer-map' as const : matchingGoals.length ? 'selected-goal' as const : 'catalog-exploration' as const };
  }).sort((a, b) => {
    const priority = (item: PracticeRecommendation) => item.fresh ? item.matchedCompetencyIds.length ? 0 : item.matchedGoalIds.length ? 1 : 2 : item.matchedCompetencyIds.length ? 3 : item.matchedGoalIds.length ? 4 : 5;
    const firstGap = (item: PracticeRecommendation) => item.matchedCompetencyIds.length ? Math.min(...item.matchedCompetencyIds.map(id => gaps.findIndex(gap => gap.id === id))) : gaps.length;
    return priority(a) - priority(b) || b.matchedGoalIds.length - a.matchedGoalIds.length || firstGap(a) - firstGap(b) || b.matchedCompetencyIds.length - a.matchedCompetencyIds.length || compare(a.scenarioId, b.scenarioId);
  });
  const gapsWithoutFreshTask = gaps.filter(gap => !recommendations.some(item => item.fresh && item.matchedCompetencyIds.includes(gap.id))).map(gap => gap.id);
  const known = new Set([...skills.map(skill => skill.id), ...unobserved.keys(), ...[...published.values()].flatMap(scenario => scenario.rubric.flatMap(criterion => [...competencies(criterion.id)]))]);
  const unresolvedGoals = selected.filter(goal => !known.has(goal));
  const targetTags = new Set([...gaps.flatMap(gap => [...competencies(gap.id)]), ...selectedTags]);
  const foundryLessons = lessons.filter(item => item.competencies.some(id => targetTags.has(id))).map(item => structuredClone(item));
  const steps: StudyStep[] = [];
  const first = recommendations.find(item => item.fresh && item.matchedCompetencyIds.length) ?? recommendations.find(item => item.fresh && item.matchedGoalIds.length) ?? recommendations.find(item => item.fresh);
  if (first) steps.push({ kind: 'scenario', id: `scenario:${first.scenarioId}@${first.version}`, title: first.title, reason: first.reason, href: first.href, scenarioId: first.scenarioId, version: first.version, fresh: first.fresh, competencyIds: unique([...first.matchedCompetencyIds, ...first.matchedGoalIds]), estimatedMinutes: first.durationMinutes });
  const drillChoices = gaps.flatMap(gap => {
    const latest = gap.history.at(-1)!, session = byId.get(latest.sessionId)!;
    return session.scenario.drills.filter(drill => drill.competencyId === gap.id).map(drill => ({ gap, session, drill, completed: session.completedDrillIds.includes(drill.id) }));
  }).sort((a, b) => Number(a.completed) - Number(b.completed) || gaps.indexOf(a.gap) - gaps.indexOf(b.gap) || compare(a.drill.id, b.drill.id));
  const drill = drillChoices[0];
  if (drill) steps.push({ kind: 'drill', id: `drill:${drill.session.id}:${drill.drill.id}`, title: drill.drill.title, reason: `Practise ${drill.gap.name} using the authored drill from its original scenario version.${drill.completed ? ' Completion was self-reported; revisit the exercise before another attempt.' : ''}`, href: `/interview-practice/${encodeURIComponent(drill.session.id)}`, sessionId: drill.session.id, scenarioId: drill.session.scenarioId, scenarioVersion: drill.session.scenarioVersion, drillId: drill.drill.id, competencyIds: [drill.gap.id], lesson: drill.drill.lesson, exercise: drill.drill.exercise, completedSelfReport: drill.completed });
  const resource = foundryLessons[0];
  if (resource && steps.length < 3) steps.push({ kind: 'lesson', id: `lesson:${resource.id}`, title: resource.title, reason: 'Review this related Foundry lesson. Its route is verified in the main Foundry source; opening it requires that integration.', foundryPath: resource.foundryPath, competencyIds: resource.competencies.filter(id => targetTags.has(id)), estimatedMinutes: resource.estimatedMinutes, requiresFoundryIntegration: true });
  if (!first && recommendations.length && steps.length < 3) {
    const repeat = recommendations[0];
    steps.push({ kind: 'scenario', id: `scenario:${repeat.scenarioId}@${repeat.version}`, title: repeat.title, reason: `${repeat.reason} No unseen catalog task is available, so this repeat cannot establish fresh-task transfer.`, href: repeat.href, scenarioId: repeat.scenarioId, version: repeat.version, fresh: false, competencyIds: unique([...repeat.matchedCompetencyIds, ...repeat.matchedGoalIds]), estimatedMinutes: repeat.durationMinutes });
  }
  const catalogLimited = !recommendations.some(item => item.fresh) || gapsWithoutFreshTask.length > 0;
  const status = assessedAttempts === 0 ? 'cold-start' : catalogLimited ? 'catalog-limited' : 'provisional';
  return {
    skills, recommendations,
    studyPlan: {
      policyVersion: 'deterministic-v1', status, selectedCompetencies: selected, steps: steps.slice(0, 3),
      explanation: assessedAttempts === 0 ? 'There are no completed report observations yet. Start with a task aligned with your goals and finish its debrief; no weakness is inferred.' : !skills.length ? 'The latest reports contain no usable observed findings. Missing observations are not weaknesses; collect evidence in another attempt.' : catalogLimited ? 'Use related drills and available practice while the catalog grows. Some competencies lack an unseen matching task, so transfer cannot yet be checked.' : 'Use the latest evidence-linked findings to choose related practice, then collect evidence on an unseen task. The profile remains provisional.',
      limitations: [...(catalogLimited ? ['The catalog cannot provide fresh matching coverage for every observed gap.'] : []), ...(ignoredFindings ? ['Findings with unknown criteria or missing/invalid evidence were excluded.'] : []), ...(unresolvedGoals.length ? ['Some selected competencies have no authored catalog mapping.'] : []), 'Drill completion is self-report and does not create a skill observation.', 'Related Foundry lesson paths are source references until the main-site integration supplies navigation.'],
      foundryLessons,
    },
    details: {
      attempts: attempts.length, completedAttempts: attempts.filter(attempt => attempt.lifecycle === 'completed').length, assessedAttempts, originalReportsSuperseded,
      evidenceCount: evidence.size, ignoredFindings, unobserved: [...unobserved.values()].sort((a, b) => compare(a.id, b.id)), unresolvedGoals, gapsWithoutFreshTask,
      evidencePolicy: { freshDistinctTasksForBroaderCoverage: 2, findingsPerAttemptPerCriterion: 1, assistancePenalty: false, drillCompletion: 'learner-self-report' },
    },
  };
}
