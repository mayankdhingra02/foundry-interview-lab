import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { toPublicScenario } from '../lib/interview-practice/domain';
import { parsePracticeEvent } from '../lib/interview-practice/events';
import { isUnseenFocusedRetest } from '../lib/interview-practice/telemetry-learning';
import type { SessionView } from '../lib/interview-practice/types';

function fixture(scenarioId: string, createdAt: string): SessionView {
  const scenario = toPublicScenario(getScenario(scenarioId)!), id = randomUUID();
  const evidence = [{ id: 'unit-observation', kind: 'test' as const, label: 'Synthetic policy fixture', content: 'Not runtime qualification.', sha256: 'a'.repeat(64), source: 'unit-fixture' }];
  return {
    id, scenarioId, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'completed', stageId: 'debrief', revision: 1,
    configuration: { role: 'Backend engineer', level: scenario.level, skills: scenario.tags, targetMinutes: scenario.durationMinutes, aiHelp: false, accommodations: [] },
    files: scenario.files, codeFrozenSnapshotId: 'unit-snapshot', frozenEvidence: { digest: 'b'.repeat(64), watermark: 0, items: evidence, frozenAt: createdAt },
    events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], evidence,
    reports: [{ id: randomUUID(), generationId: randomUUID(), createdAt, model: 'synthetic-unit-only', promptVersion: 'unit', rubricVersion: scenario.version, evidenceDigest: 'b'.repeat(64), evidence, overview: 'Synthetic fixture only.',
      rubric: scenario.rubric.map(criterion => ({ criterionId: criterion.id, level: criterion.id === 'money-verification' ? 'Needs work' as const : 'Strong' as const, feedback: 'Synthetic policy fixture.', evidenceIds: ['unit-observation'], confidence: 'low' as const })), nextPractice: scenario.drills.map(drill => ({ drillId: drill.id, reason: 'Synthetic suggestion.' })) }],
    usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt, updatedAt: createdAt, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh',
  };
}
function sequence() {
  const prior = fixture('monetary-validation', '2026-10-08T12:00:00.000Z'), current = fixture('event-rollup', '2026-10-09T12:00:00.000Z');
  const drill = prior.scenario.drills.find(drill => drill.competencyId === 'money-verification')!;
  prior.events.push(parsePracticeEvent({ id: randomUUID(), sessionId: prior.id, sequence: 1, schemaVersion: 1, source: 'learner', type: 'drill.completed', requestId: randomUUID(), occurredAt: '2026-10-08T13:00:00.000Z', recordedAt: '2026-10-08T13:00:00.000Z', payload: { drillId: drill.id, provenance: 'learner-self-report' } }));
  return { prior, current };
}
describe('saved-history focused retest measurement', () => {
  it('requires an actual earlier suggested self-reported drill and an authored gap transfer to a completed fresh task', () => {
    const { prior, current } = sequence();
    expect(isUnseenFocusedRetest(current, [current, prior])).toBe(true);
    expect(isUnseenFocusedRetest(current, [current])).toBe(false);
    prior.events = []; expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
  it('does not turn arbitrary completion, an unrelated drill, absent evidence or Not observed into a retest', () => {
    for (const change of ['future-drill', 'unrelated-drill', 'no-suggestion', 'no-evidence', 'unobserved', 'strong'] as const) {
      const { prior, current } = sequence();
      if (change === 'future-drill') prior.events[0].occurredAt = '2026-10-10T00:00:00.000Z';
      if (change === 'unrelated-drill' && prior.events[0].type === 'drill.completed') prior.events[0].payload.drillId = prior.scenario.drills.find(drill => drill.competencyId !== 'money-verification')!.id;
      if (change === 'no-suggestion') prior.reports[0].nextPractice = [];
      if (change === 'no-evidence') prior.reports[0].rubric.forEach(row => { row.evidenceIds = []; });
      if (change === 'unobserved' || change === 'strong') prior.reports[0].rubric.forEach(row => { row.level = change === 'unobserved' ? 'Not observed' : 'Strong'; });
      expect(isUnseenFocusedRetest(current, [prior]), change).toBe(false);
    }
  });
  it('blocks retained same-family exposure, stored repeated flags, and unfinished report generation', () => {
    const { prior, current } = sequence();
    const seen = fixture('event-rollup', '2026-10-07T12:00:00.000Z');
    expect(isUnseenFocusedRetest(current, [prior, seen])).toBe(false);
    seen.scenarioId = 'another-variant'; Object.assign(seen.scenario, { id: 'another-variant', familyId: current.scenarioId });
    expect(isUnseenFocusedRetest(current, [prior, seen])).toBe(false);
    current.promptExposure = 'repeated'; expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
    current.promptExposure = 'fresh'; current.lifecycle = 'reviewing'; expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
});
