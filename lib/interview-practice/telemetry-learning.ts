import { buildProgression } from './progression';
import { scenarioFamilyId } from './curriculum';
import { parseSessionEvents, type PracticeEvent } from './events';
import type { CoachingReport, SessionView } from './types';
import { z } from 'zod';

const family = (session: SessionView) => scenarioFamilyId(session.scenario);
const timestamp = z.string().datetime({ offset: true });
const eventClock = (event: PracticeEvent) => Math.max(Date.parse(event.occurredAt), Date.parse(event.recordedAt));
type PublishedReport = { report: CoachingReport; publishedAt: number; sequence?: number };

/** Generation time alone cannot establish when feedback became available. */
function publicationHistory(session: SessionView, events: PracticeEvent[]): PublishedReport[] | null {
  const result: PublishedReport[] = [];
  if (new Set(session.reports.map(report => report.id)).size !== session.reports.length) return null;
  for (const [index, report] of session.reports.entries()) {
    const records = events.filter(event => (event.type === 'coaching.ready' || event.type === 'coaching.corrected') && event.payload.reportId === report.id);
    let publishedAt: number, sequence: number | undefined;
    if (report.correction) {
      if (!timestamp.safeParse(report.correction.publishedAt).success || !session.reports.slice(0, index).some(source => source.id === report.correction!.sourceReportId) || records.length > 1) return null;
      publishedAt = Date.parse(report.correction.publishedAt);
      if (records.length) {
        const event = records[0];
        if (event.type !== 'coaching.corrected' || event.source !== 'server' || event.payload.sourceReportId !== report.correction.sourceReportId || event.payload.generationId !== report.generationId || event.payload.reason !== report.correction.reason) return null;
        publishedAt = Math.max(publishedAt, eventClock(event)); sequence = event.sequence;
      }
    } else {
      const event = records[0];
      if (records.length !== 1 || event.type !== 'coaching.ready' || !['server', 'model'].includes(event.source)) return null;
      publishedAt = eventClock(event); sequence = event.sequence;
    }
    if (!Number.isFinite(publishedAt) || publishedAt < Date.parse(session.createdAt) || (result.length && publishedAt < result.at(-1)!.publishedAt)) return null;
    if (sequence !== undefined && result.some(item => item.sequence !== undefined && item.sequence >= sequence!)) return null;
    result.push({ report, publishedAt, ...(sequence === undefined ? {} : { sequence }) });
  }
  return result;
}

/** Describes an observed practice sequence, never improvement or mastery.
 * "Unseen" is limited to this owner's saved catalog-family history. */
export function isUnseenFocusedRetest(current: SessionView, history: SessionView[]): boolean {
  if (current.lifecycle !== 'completed' || !current.reports.length || !current.frozenEvidence || current.promptExposure !== 'fresh') return false;
  const started = Date.parse(current.createdAt);
  if (!Number.isFinite(started)) return false;
  const earlier = history.filter(row => row.id !== current.id && Date.parse(row.createdAt) <= started);
  if (earlier.some(row => family(row) === family(current))) return false;
  const practiced = new Set<string>(), drilled: SessionView[] = [];
  for (const row of earlier) {
    if (row.lifecycle !== 'completed' || !row.reports.length) continue;
    let events: PracticeEvent[];
    try { events = parseSessionEvents(row.events, row.id); } catch { continue; }
    const published = publicationHistory(row, events);
    // An undated/ambiguous publication could supersede the apparent earlier gap.
    // Its absence is a missing diagnostic, never permission to invent ordering.
    if (!published) continue;
    const beforeRetest = published.filter(item => item.publishedAt < started);
    if (!beforeRetest.length) continue;
    let qualifyingDrill = false;
    for (const event of events) {
      if (event.type !== 'drill.completed' || event.source !== 'learner') continue;
      const drillAt = eventClock(event), beforeDrill = published.filter(item => item.publishedAt < drillAt && (item.sequence === undefined || item.sequence < event.sequence));
      if (drillAt >= started || !beforeDrill.length || !beforeDrill.at(-1)!.report.nextPractice.some(next => next.drillId === event.payload.drillId)) continue;
      const drill = row.scenario.drills.find(item => item.id === event.payload.drillId);
      if (!drill) continue;
      const asOfDrill = { ...row, reports: beforeDrill.map(item => item.report) };
      if (!buildProgression([asOfDrill], []).skills.some(skill => skill.id === drill.competencyId && ['Developing', 'Needs work'].includes(skill.level))) continue;
      practiced.add(drill.competencyId); qualifyingDrill = true;
    }
    if (qualifyingDrill) drilled.push({ ...row, reports: beforeRetest.map(item => item.report) });
  }
  if (!drilled.length) return false;
  return buildProgression(drilled, [current.scenario]).recommendations.some(item =>
    item.scenarioId === current.scenarioId && item.fresh && item.matchedCompetencyIds.some(id => practiced.has(id)));
}
