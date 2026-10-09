import { buildProgression } from './progression';
import { scenarioFamilyId } from './curriculum';
import type { SessionView } from './types';

const family = (session: SessionView) => scenarioFamilyId(session.scenario);

/** Describes an observed practice sequence, never improvement or mastery.
 * "Unseen" is limited to this owner's saved catalog-family history. */
export function isUnseenFocusedRetest(current: SessionView, history: SessionView[]): boolean {
  if (current.lifecycle !== 'completed' || !current.reports.length || !current.frozenEvidence || current.promptExposure !== 'fresh') return false;
  const started = Date.parse(current.createdAt);
  if (!Number.isFinite(started)) return false;
  const earlier = history.filter(row => row.id !== current.id && Date.parse(row.createdAt) <= started);
  if (earlier.some(row => family(row) === family(current))) return false;
  const practiced = new Set<string>();
  const drilled = earlier.filter(row => row.lifecycle === 'completed' && row.reports.length && row.events.filter(event => {
    if (event.type !== 'drill.completed' || Date.parse(event.occurredAt) >= started
      || !row.reports.at(-1)!.nextPractice.some(next => next.drillId === event.payload.drillId)) return false;
    const drill = row.scenario.drills.find(drill => drill.id === event.payload.drillId);
    if (!drill) return false;
    practiced.add(drill.competencyId); return true;
  }).length > 0);
  if (!drilled.length) return false;
  return buildProgression(drilled, [current.scenario]).recommendations.some(item =>
    item.scenarioId === current.scenarioId && item.fresh && item.matchedCompetencyIds.some(id => practiced.has(id)));
}
