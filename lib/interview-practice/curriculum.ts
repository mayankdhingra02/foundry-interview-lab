/** Editorial preparation metadata; no inferred mastery or difficulty calibration. */
export type PracticeTier = 'Junior' | 'Mid-level' | 'Senior';
export type ScenarioPrerequisite = {
  id: string; title: string; description: string;
  lesson?: { id: string; foundryPath: string };
};
export type ScenarioCurriculum = {
  tier: PracticeTier; calibration: 'unreviewed';
  constraints: string[]; prerequisites: ScenarioPrerequisite[];
};
export type CurriculumScenario = { id: string; level?: string; familyId?: string; curriculum?: ScenarioCurriculum };

// Kept outside the five admitted v1 packages so their historical digests do not
// change. A historical variant missing optional metadata is still a repeat.
const authoredFamilies: Readonly<Record<string, string>> = {
  'inventory-reservations': 'inventory-reservations',
  'stock-foundations': 'inventory-reservations',
  'stock-retries': 'inventory-reservations',
  'stock-lifecycle': 'inventory-reservations',
};
export function scenarioFamilyId(scenario: Pick<CurriculumScenario, 'id' | 'familyId'>): string {
  return Object.hasOwn(authoredFamilies, scenario.id) ? authoredFamilies[scenario.id] : scenario.familyId ?? scenario.id;
}
export function scenarioTier(scenario: CurriculumScenario): PracticeTier | null {
  if (scenario.curriculum) return scenario.curriculum.tier;
  return scenario.level === 'Intermediate' ? 'Mid-level' : scenario.level === 'Advanced' ? 'Senior' : null;
}
export function hasSeenScenarioFamily(scenario: Pick<CurriculumScenario, 'id' | 'familyId'>, seen: Iterable<Pick<CurriculumScenario, 'id' | 'familyId'>>): boolean {
  const family = scenarioFamilyId(scenario);
  return [...seen].some(previous => scenarioFamilyId(previous) === family);
}

const lessonPaths: Readonly<Record<string, string>> = {
  correctness: '/dsa/foundations/correctness',
  'state-lifecycle-errors': '/low-level-design/lessons/state-lifecycle-errors',
  'concurrency-testability-evolution': '/low-level-design/lessons/concurrency-testability-evolution',
};
/** Exact authored lesson references only. Rendering a URL requires the existing
 * reviewed Foundry-origin integration; a prerequisite is never a skill lock. */
export function isCurriculumLessonReference(id: string, foundryPath: string): boolean {
  return Object.hasOwn(lessonPaths, id) && lessonPaths[id] === foundryPath;
}
export function validateCurriculum(scenario: CurriculumScenario): void {
  if (!scenario.curriculum) {
    if (scenario.familyId !== undefined) throw new Error('Family metadata requires an authored curriculum.');
    return;
  }
  const { curriculum } = scenario;
  if (!scenario.familyId || scenario.familyId !== scenarioFamilyId({ id: scenario.id })) throw new Error('Scenario family must match the authored family registry.');
  if (scenario.level !== curriculum.tier) throw new Error('Scenario level must match its authored tier.');
  if (curriculum.calibration !== 'unreviewed') throw new Error('Curriculum difficulty remains unreviewed.');
  if (!curriculum.constraints.length || !curriculum.prerequisites.length) throw new Error('Curriculum needs substantive constraints and prerequisites.');
  if (new Set(curriculum.prerequisites.map(item => item.id)).size !== curriculum.prerequisites.length) throw new Error('Duplicate curriculum prerequisite.');
  if (curriculum.prerequisites.some(item => item.lesson && !isCurriculumLessonReference(item.lesson.id, item.lesson.foundryPath))) throw new Error('Unknown curriculum lesson reference.');
}
