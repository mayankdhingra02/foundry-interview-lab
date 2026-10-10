import { describe, expect, it } from 'vitest';
import { getScenario, listPracticeScenarios, listScenarios } from '../lib/content/scenarios';
import { withScenarioPreparation } from '../lib/content/preparation';
import { digest, toPublicScenario } from '../lib/interview-practice/domain';
import { buildProgression, isAuthoredFoundryLesson } from '../lib/interview-practice/progression';
import { withFoundryNavigation } from '../lib/server/foundry-navigation';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';

describe('version-bound original-task preparation', () => {
  it('projects substantive preparation for all five original contracts without editing their packages', () => {
    for (const scenario of listScenarios()) {
      const original = structuredClone(scenario), published = withScenarioPreparation(scenario);
      expect(published.preparation).toMatchObject({ version: '1', scenarioId: scenario.id, scenarioVersion: scenario.version, scenarioDigest: digest(scenario), reviewStatus: 'draft' });
      expect(published.preparation!.prerequisites.length).toBeGreaterThanOrEqual(2);
      for (const prerequisite of published.preparation!.prerequisites) {
        expect(prerequisite.description.length).toBeGreaterThan(70);
        expect(isAuthoredFoundryLesson(prerequisite.lesson!.id, prerequisite.lesson!.foundryPath)).toBe(true);
      }
      const { preparation: _guidance, ...publicFields } = published;
      void _guidance;
      expect(publicFields).toEqual(toPublicScenario(scenario));
      expect(scenario).toEqual(original);
      expect(scenario).not.toHaveProperty('preparation');
      expect(published).not.toHaveProperty('referenceFiles');
      expect(published).not.toHaveProperty('hints');
      expect(published.tests.filter(test => !test.visible).every(test => !Object.hasOwn(test, 'source'))).toBe(true);
    }
    expect(new Set(listScenarios().flatMap(s => withScenarioPreparation(s).preparation!.prerequisites.map(p => p.id))).size).toBe(11);
  });
  it('does not lend known guidance to another version, changed private contract, or unknown ID', () => {
    const scenario = listScenarios()[0];
    for (const changed of [{ ...scenario, version: '2.0.0' }, { ...scenario, id: 'toString' }, { ...scenario, referenceFiles: { ...scenario.referenceFiles, 'unrelated.py': '# Changed private package' } }, { ...scenario, tests: scenario.tests.map(test => ({ ...test, source: test.source + '\n# Changed contract' })) }]) {
      expect(withScenarioPreparation(changed)).not.toHaveProperty('preparation');
    }
    const first = withScenarioPreparation(scenario); first.preparation!.prerequisites[0].title = 'Mutated caller copy';
    expect(withScenarioPreparation(scenario).preparation!.prerequisites[0].title).not.toBe('Mutated caller copy');
  });
  it('keeps level-draft curriculum and benchmark/session identities unchanged', async () => {
    for (const scenario of listPracticeScenarios().filter(s => s.curriculum)) expect(withScenarioPreparation(scenario)).toEqual(toPublicScenario(scenario));
    const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario);
    const scenario = listScenarios()[0];
    const created = await service.createSession('preparation-owner', { scenarioId: scenario.id, requestId: 'preparation-create' });
    const stored = (await store.read()).sessions[created.session.id];
    expect(stored.scenarioDigest).toBe(digest(scenario));
    expect(stored.scenario).toEqual(toPublicScenario(scenario));
    expect(stored.scenario).not.toHaveProperty('preparation');
  });
  it('adds prerequisites to recommendations and resolves only reviewed configured lesson destinations', () => {
    const catalog = listScenarios().map(withScenarioPreparation), plan = buildProgression([], catalog);
    expect(plan.recommendations).toHaveLength(5);
    for (const recommendation of plan.recommendations) expect(recommendation.prerequisites).toEqual(catalog.find(s => s.id === recommendation.scenarioId)!.preparation!.prerequisites);
    expect(plan.skills).toEqual([]);
    expect(plan.recommendations.every(row => row.matchedCompetencyIds.length === 0)).toBe(true);
    const unavailable = withFoundryNavigation(plan, { production: true });
    expect(unavailable.studyPlan.foundryLessons.every(row => row.navigation?.status === 'unavailable')).toBe(true);
    const configured = withFoundryNavigation(plan, { origin: 'https://foundry.example', production: true });
    expect(configured.studyPlan.foundryLessons.length).toBeGreaterThan(0);
    for (const row of configured.studyPlan.foundryLessons) expect(row.navigation).toEqual({ status: 'available', href: 'https://foundry.example' + row.foundryPath });
    expect(buildProgression([], catalog)).toEqual(plan);
  });
});
