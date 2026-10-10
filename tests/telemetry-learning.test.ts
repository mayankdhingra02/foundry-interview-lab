import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { toPublicScenario } from '../lib/interview-practice/domain';
import { parsePracticeEvent } from '../lib/interview-practice/events';
import { isUnseenFocusedRetest } from '../lib/interview-practice/telemetry-learning';
import type { SessionView } from '../lib/interview-practice/types';

function fixture(scenarioId: string, createdAt: string): SessionView {
  const scenario = toPublicScenario(getScenario(scenarioId)!), id = randomUUID(), reportId = randomUUID();
  const evidence = [{ id: 'unit-observation', kind: 'test' as const, label: 'Synthetic policy fixture', content: 'Not runtime qualification.', sha256: 'a'.repeat(64), source: 'unit-fixture' }];
  return {
    id, scenarioId, scenarioVersion: scenario.version, scenario, mode: 'practice', lifecycle: 'completed', stageId: 'debrief', revision: 1,
    configuration: { role: 'Backend engineer', level: scenario.level, skills: scenario.tags, targetMinutes: scenario.durationMinutes, aiHelp: false, accommodations: [] },
    files: scenario.files, codeFrozenSnapshotId: 'unit-snapshot', frozenEvidence: { digest: 'b'.repeat(64), watermark: 0, items: evidence, frozenAt: createdAt },
    events: [parsePracticeEvent({ id: randomUUID(), sessionId: id, sequence: 1, schemaVersion: 1, source: 'model', type: 'coaching.ready', requestId: randomUUID(), occurredAt: createdAt, recordedAt: createdAt, payload: { reportId, jobId: randomUUID() } })], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], evidence,
    reports: [{ id: reportId, generationId: randomUUID(), createdAt, model: 'synthetic-unit-only', promptVersion: 'unit', rubricVersion: scenario.version, evidenceDigest: 'b'.repeat(64), evidence, overview: 'Synthetic fixture only.',
      rubric: scenario.rubric.map(criterion => ({ criterionId: criterion.id, level: criterion.id === 'money-verification' ? 'Needs work' as const : 'Strong' as const, feedback: 'Synthetic policy fixture.', evidenceIds: ['unit-observation'], confidence: 'low' as const })), nextPractice: scenario.drills.map(drill => ({ drillId: drill.id, reason: 'Synthetic suggestion.' })) }],
    usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt, updatedAt: createdAt, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh',
  };
}
function sequence() {
  const prior = fixture('monetary-validation', '2026-10-08T12:00:00.000Z'), current = fixture('event-rollup', '2026-10-09T12:00:00.000Z');
  const drill = prior.scenario.drills.find(drill => drill.competencyId === 'money-verification')!;
  prior.events.push(parsePracticeEvent({ id: randomUUID(), sessionId: prior.id, sequence: prior.events.length + 1, schemaVersion: 1, source: 'learner', type: 'drill.completed', requestId: randomUUID(), occurredAt: '2026-10-08T13:00:00.000Z', recordedAt: '2026-10-08T13:00:00.000Z', payload: { drillId: drill.id, provenance: 'learner-self-report' } }));
  return { prior, current };
}
const drillEvent = (session: SessionView) => session.events.find(event => event.type === 'drill.completed')!;
function correction(session: SessionView, level: 'Strong' | 'Needs work', publishedAt: string, eventAt: string | null = publishedAt) {
  const source = session.reports.at(-1)!, report = structuredClone(source);
  report.id = randomUUID(); report.generationId = randomUUID(); report.model = 'staff-reviewed';
  // Intentionally retain an earlier generation timestamp; it is not publication.
  report.correction = { sourceReportId: source.id, reason: 'Synthetic chronology correction.', publishedAt };
  report.rubric.forEach(finding => { finding.level = level; }); session.reports.push(report);
  if (eventAt) {
    const event = parsePracticeEvent({ id: randomUUID(), sessionId: session.id, sequence: session.events.length + 1, schemaVersion: 1, source: 'server', type: 'coaching.corrected', requestId: randomUUID(), occurredAt: eventAt, recordedAt: eventAt, payload: { reportId: report.id, sourceReportId: source.id, generationId: report.generationId, reason: report.correction.reason } });
    const before = session.events.findIndex(item => Date.parse(item.recordedAt) > Date.parse(eventAt));
    session.events.splice(before < 0 ? session.events.length : before, 0, event); session.events.forEach((item, index) => { item.sequence = index + 1; });
  }
  return report;
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
      if (change === 'future-drill') drillEvent(prior).occurredAt = '2026-10-10T00:00:00.000Z';
      if (change === 'unrelated-drill' && drillEvent(prior).type === 'drill.completed') drillEvent(prior).payload.drillId = prior.scenario.drills.find(drill => drill.competencyId !== 'money-verification')!.id;
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
  it('rejects a future original publication even when its generation timestamp and drill are earlier', () => {
    const { prior, current } = sequence();
    prior.events[0].occurredAt = prior.events[0].recordedAt = '2026-10-10T00:00:00.000Z';
    expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
  it('requires an already published suggestion and observed gap before the actual drill', () => {
    for (const time of ['2026-10-08T11:00:00.000Z', '2026-10-08T12:00:00.000Z']) {
      const { prior, current } = sequence(); drillEvent(prior).occurredAt = drillEvent(prior).recordedAt = time;
      expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
    }
    const { prior, current } = sequence(); prior.reports[0].rubric.forEach(finding => { finding.level = 'Strong'; });
    correction(prior, 'Needs work', '2026-10-08T14:00:00.000Z');
    expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
  it('does not retroactively create a focused retest from a correction published after retest start', () => {
    const { prior, current } = sequence(); prior.reports[0].rubric.forEach(finding => { finding.level = 'Strong'; });
    correction(prior, 'Needs work', '2026-10-10T00:00:00.000Z');
    expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
  it('keeps the actual earlier gap/drill/retest sequence when a later correction changes the latest report', () => {
    const { prior, current } = sequence(); correction(prior, 'Strong', '2026-10-10T00:00:00.000Z');
    expect(isUnseenFocusedRetest(current, [prior])).toBe(true);
  });
  it('uses the corrected publication event or explicit correction metadata instead of the old generation timestamp', () => {
    for (const withEvent of [true, false]) {
      const { prior, current } = sequence(); prior.reports[0].rubric.forEach(finding => { finding.level = 'Strong'; });
      const at = '2026-10-08T12:30:00.000Z'; correction(prior, 'Needs work', at, withEvent ? at : null);
      expect(isUnseenFocusedRetest(current, [prior])).toBe(true);
    }
    const { prior, current } = sequence(); prior.reports[0].rubric.forEach(finding => { finding.level = 'Strong'; });
    correction(prior, 'Needs work', '2026-10-08T12:30:00.000Z', '2026-10-10T00:00:00.000Z');
    expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
  it('treats unknown, malformed, foreign or ambiguous publication as missing diagnostics', () => {
    for (const change of [
      (prior: SessionView) => { prior.events.splice(0, 1); prior.events[0].sequence = 1; },
      (prior: SessionView) => { prior.events[0].sessionId = randomUUID(); },
      (prior: SessionView) => { prior.events[0].source = 'learner'; },
      (prior: SessionView) => { prior.events.push({ ...structuredClone(prior.events[0]), id: randomUUID(), sequence: 3 }); },
      (prior: SessionView) => { correction(prior, 'Strong', 'invalid-clock', null); },
      (prior: SessionView) => { const report = correction(prior, 'Strong', '2026-10-10T00:00:00.000Z'); const event = prior.events.at(-1)!; if (event.type === 'coaching.corrected') event.payload.generationId = randomUUID(); expect(report.generationId).not.toBe(event.type === 'coaching.corrected' ? event.payload.generationId : ''); },
    ]) { const { prior, current } = sequence(); change(prior); expect(isUnseenFocusedRetest(current, [prior])).toBe(false); }
  });
  it('uses recorded publication/drill timing conservatively and requires the gap still available before retest start', () => {
    const first = sequence(); first.prior.events[0].recordedAt = '2026-10-10T00:00:00.000Z'; expect(isUnseenFocusedRetest(first.current, [first.prior])).toBe(false);
    const second = sequence(); drillEvent(second.prior).recordedAt = '2026-10-10T00:00:00.000Z'; expect(isUnseenFocusedRetest(second.current, [second.prior])).toBe(false);
    const third = sequence(); correction(third.prior, 'Strong', '2026-10-08T14:00:00.000Z'); expect(isUnseenFocusedRetest(third.current, [third.prior])).toBe(false);
  });
  it('does not combine an unfocused drill from one attempt with a different attempt\'s gap', () => {
    const { prior, current } = sequence(), other = sequence().prior;
    prior.reports[0].rubric.forEach(finding => { finding.level = 'Strong'; });
    drillEvent(other).payload.drillId = other.scenario.drills.find(drill => drill.competencyId !== 'money-verification')!.id;
    expect(isUnseenFocusedRetest(current, [prior, other])).toBe(false);
  });
  it('rejects a backdated corrected publication event appended after the drill', () => {
    const { prior, current } = sequence(); prior.reports[0].rubric.forEach(finding => { finding.level = 'Strong'; });
    correction(prior, 'Needs work', '2026-10-08T12:30:00.000Z');
    const corrected = prior.events.splice(1, 1)[0]; prior.events.push(corrected); prior.events.forEach((event, index) => { event.sequence = index + 1; });
    expect(isUnseenFocusedRetest(current, [prior])).toBe(false);
  });
});
