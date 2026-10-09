import 'server-only';

import { resolve } from 'node:path';
import type { Scenario } from '../interview-practice/types';
import { loadScenarioPackage } from './scenario-package';

/** Fixed original development benchmark corpus. Do not silently expand it. */
const baselineIds = ['monetary-validation', 'extension-compatibility', 'duplicate-invoice', 'inventory-reservations', 'event-rollup'];
const draftIds = ['stock-foundations', 'stock-retries', 'stock-lifecycle'];
let loadedCatalog: Scenario[] | undefined;
let loadedDrafts: Scenario[] | undefined;

/** Full server-only baseline packages, retained for benchmark comparability. */
export function listScenarios(): Scenario[] {
  loadedCatalog ??= baselineIds.map(id => loadScenarioPackage(resolve(process.cwd(), 'content/scenarios', id), id));
  return structuredClone(loadedCatalog);
}

/** Runtime candidate catalog. Existing rollout admission still filters these
 * packages; authored difficulty labels are explicitly unreviewed. */
export function listPracticeScenarios(): Scenario[] {
  loadedDrafts ??= draftIds.map(id => loadScenarioPackage(resolve(process.cwd(), 'content/level-scenarios', id), id));
  return [...listScenarios(), ...structuredClone(loadedDrafts)];
}

/** Exact allowlisted IDs only; learner input never becomes a filesystem path. */
export function getScenario(id: string, version?: string): Scenario | null {
  return listPracticeScenarios().find(scenario => scenario.id === id && (version === undefined || scenario.version === version)) ?? null;
}

export type ScenarioSummary = Pick<Scenario, 'id' | 'version' | 'title' | 'summary' | 'durationMinutes' | 'level' | 'tags' | 'language' | 'familyId' | 'curriculum'>;

/** Safe runtime cards; private files, probes and test sources are omitted. */
export function listScenarioSummaries(): ScenarioSummary[] {
  return listPracticeScenarios().map(({ id, version, title, summary, durationMinutes, level, tags, language, familyId, curriculum }) => ({
    id, version, title, summary, durationMinutes, level, tags, language,
    ...(familyId === undefined ? {} : { familyId }), ...(curriculum === undefined ? {} : { curriculum }),
  }));
}
