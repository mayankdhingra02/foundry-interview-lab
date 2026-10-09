import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getScenario, listPracticeScenarios, listScenarios, listScenarioSummaries } from '../lib/content/scenarios';
import { loadScenarioPackage } from '../lib/content/scenario-package';
import { hasSeenScenarioFamily, scenarioFamilyId, scenarioTier, validateCurriculum } from '../lib/interview-practice/curriculum';
import { digest, toPublicScenario } from '../lib/interview-practice/domain';
import { buildProgression, isAuthoredFoundryLesson } from '../lib/interview-practice/progression';
import { withFoundryNavigation } from '../lib/server/foundry-navigation';
import { admittedScenarios, rolloutAdmissionPolicy } from '../lib/server/rollout';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import type { SessionView } from '../lib/interview-practice/types';
import { afterEach, vi } from 'vitest';
import nextConfig from '../next.config';

const drafts = listPracticeScenarios().filter(scenario => scenario.curriculum);
const baselineDigests = {
  'monetary-validation': 'd3f2ac3863992c2b5f2cd2d9e11a0b99773d152c20e7c3dee14747ada9369a98',
  'extension-compatibility': '7ed7b5ad9fee02413374026a5f15c1ea0708fea7dd09808632e7b48ff3d8c8d3',
  'duplicate-invoice': '32cf761542641adc896bf8b95276f5c33dbd0ee9c2f221f7f6f663aafe4554fe',
  'inventory-reservations': 'fbad580a10702b71c855b025ba69202fdc3a76b47bb99f8135ef109971ae3b0e',
  'event-rollup': '1d44d0cb79bc1a694e7d19051a20ddbb3bf2a9194c41dfc8a75ff2a0c581300f',
};
afterEach(() => vi.unstubAllEnvs());

function malformed(edit: (manifest: Record<string, unknown>) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-curriculum-'));
  try {
    cpSync(resolve('content/level-scenarios/stock-foundations'), directory, { recursive: true });
    const file = join(directory, 'manifest.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
    edit(manifest); writeFileSync(file, JSON.stringify(manifest));
    return loadScenarioPackage(directory, 'stock-foundations');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('versioned original curriculum packages', () => {
  it('preserves all five hydrated v1 digests and the fixed benchmark corpus', () => {
    expect(Object.fromEntries(listScenarios().map(scenario => [scenario.id, digest(scenario)]))).toEqual(baselineDigests);
    expect(listScenarios().every(scenario => !Object.hasOwn(scenario, 'curriculum') && !Object.hasOwn(scenario, 'familyId'))).toBe(true);
    expect(listPracticeScenarios()).toHaveLength(8);
  });
  it('provides three substantively distinct contracts, tests and criteria', () => {
    expect(drafts.map(scenario => scenario.level)).toEqual(['Junior', 'Mid-level', 'Senior']);
    expect(new Set(drafts.map(scenario => digest(scenario.tests))).size).toBe(3);
    expect(new Set(drafts.flatMap(scenario => scenario.rubric.map(criterion => criterion.id))).size).toBe(9);
    expect(drafts[0].curriculum!.constraints.join(' ')).toContain('single-process in memory');
    expect(drafts[1].curriculum!.constraints.join(' ')).toContain('one durable transaction');
    expect(drafts[2].curriculum!.constraints.join(' ')).toContain('cancel');
    for (const scenario of drafts) {
      expect(scenario.curriculum!.calibration).toBe('unreviewed');
      expect(scenario.curriculum!.constraints).toEqual(scenario.stages[0].requirements);
      expect(scenario.tests.length).toBeLessThanOrEqual(8);
      expect(scenario.runtime.timeoutSeconds).toBeLessThanOrEqual(60);
      for (const item of scenario.curriculum!.prerequisites) {
        if (item.lesson) expect(isAuthoredFoundryLesson(item.lesson.id, item.lesson.foundryPath)).toBe(true);
      }
    }
    expect(nextConfig.outputFileTracingIncludes?.['/api/interview-practice/*']).toContain('./content/level-scenarios/**/*');
  });
  it('validates authored level, family and prerequisite navigation instead of trusting source text', () => {
    expect(() => malformed(manifest => { manifest.level = 'Senior'; })).toThrow('authored tier');
    expect(() => malformed(manifest => { manifest.familyId = 'unrelated-family'; })).toThrow('family registry');
    expect(() => malformed(manifest => { (manifest.curriculum as { prerequisites: unknown[] }).prerequisites = [{ id: 'unsafe', title: 'unsafe', description: 'unsafe', lesson: { id: 'correctness', foundryPath: 'https://untrusted.example/' } }]; })).toThrow('Unknown curriculum lesson');
    expect(() => malformed(manifest => { manifest.starterFiles = ['../secret']; })).toThrow('safe relative paths');
    expect(() => validateCurriculum({ id: 'stock-foundations', familyId: 'inventory-reservations' })).toThrow('requires an authored curriculum');
  });
  it('returns independent packages and transports only public curriculum metadata', () => {
    const first = getScenario('stock-foundations')!;
    first.curriculum!.constraints.pop();
    expect(getScenario('stock-foundations')!.curriculum!.constraints).toHaveLength(4);
    expect(getScenario('stock-foundations', '2.0.0')).toBeNull();
    expect(getScenario('../../stock-foundations')).toBeNull();
    const publicScenario = toPublicScenario(first);
    expect(publicScenario.curriculum?.calibration).toBe('unreviewed');
    expect(publicScenario).not.toHaveProperty('referenceFiles');
    expect(publicScenario.tests.filter(test => !test.visible).every(test => !Object.hasOwn(test, 'source'))).toBe(true);
    expect(listScenarioSummaries().find(scenario => scenario.id === first.id)).not.toHaveProperty('files');
  });
  it('keeps draft selection behind the existing exact scenario admission policy', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', 'monetary-validation');
    vi.stubEnv('PRACTICE_ADMISSION_MODE', 'open');
    expect(admittedScenarios(listPracticeScenarios()).map(scenario => scenario.id)).toEqual(['monetary-validation']);
    const service = new SessionService(new MemoryPracticeStore(), getScenario, { admissionPolicy: rolloutAdmissionPolicy() });
    await expect(service.createSession('owner', { scenarioId: 'stock-foundations', requestId: 'not-admitted' })).rejects.toMatchObject({ code: 'scenario_not_admitted' });
    expect(await service.listSessions('owner')).toEqual([]);
    vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', 'stock-foundations');
    expect((await service.createSession('owner', { scenarioId: 'stock-foundations', requestId: 'admitted' })).session.scenario.curriculum?.tier).toBe('Junior');
  });
});

describe('family exposure and prerequisite-aware navigation', () => {
  it('conservatively maps historical inventory and variants missing optional metadata', () => {
    expect(scenarioFamilyId({ id: 'stock-retries' })).toBe('inventory-reservations');
    expect(scenarioFamilyId({ id: 'stock-retries', familyId: 'untrusted-override' })).toBe('inventory-reservations');
    expect(scenarioFamilyId({ id: 'constructor' })).toBe('constructor');
    expect(hasSeenScenarioFamily(drafts[2], [{ id: 'inventory-reservations' }])).toBe(true);
    expect(scenarioTier(getScenario('inventory-reservations')!)).toBe('Senior');
    expect(getScenario('inventory-reservations')!.level).toBe('Advanced');
  });
  it('records repeated family exposure without changing old attempts or other owners', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const original = (await service.createSession('owner', { scenarioId: 'inventory-reservations', requestId: 'original-request' })).session;
    const before = await service.exportSession('owner', original.id);
    const junior = (await service.createSession('owner', { scenarioId: 'stock-foundations', requestId: 'junior-request' })).session;
    const senior = (await service.createSession('owner', { scenarioId: 'stock-lifecycle', requestId: 'senior-request' })).session;
    expect(junior.promptExposure).toBe('repeated'); expect(senior.promptExposure).toBe('repeated');
    expect(await service.exportSession('owner', original.id)).toEqual(before);
    expect((await service.createSession('other-owner', { scenarioId: 'stock-foundations', requestId: 'other-request' })).session.promptExposure).toBe('fresh');
    await service.deleteSession('owner', original.id, { requestId: 'delete-original' });
    expect((await service.getSession('owner', junior.id)).promptExposure).toBe('repeated');
  });
  it('marks same-family recommendations repeated, even if the stored fixture incorrectly says fresh', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const first = (await service.createSession('owner', { scenarioId: 'stock-foundations', requestId: 'first-request' })).session;
    const next = (await service.createSession('owner', { scenarioId: 'stock-retries', requestId: 'next-request' })).session;
    first.createdAt = '2026-10-08T00:00:00.000Z'; next.createdAt = '2026-10-09T00:00:00.000Z';
    next.promptExposure = 'fresh';
    const result = buildProgression([first, next], drafts.map(toPublicScenario));
    expect(result.recommendations.every(item => !item.fresh)).toBe(true);
    expect(result.studyPlan.steps.find(step => step.kind === 'scenario')).toMatchObject({ fresh: false });
    expect(result.studyPlan.limitations.join(' ')).toContain('cannot establish unseen-task transfer');
    // Fixture reports exercise exposure inference without provider assessment.
    const completed: SessionView = { ...next, lifecycle: 'completed', reports: [{ id: 'synthetic-report', generationId: 'synthetic-generation', createdAt: next.createdAt, model: 'synthetic-fixture', promptVersion: 'fixture', rubricVersion: next.scenarioVersion, evidenceDigest: 'a'.repeat(64), evidence: [{ id: 'synthetic-evidence', kind: 'test', label: 'Fixture', content: 'fixture', sha256: 'b'.repeat(64), source: 'synthetic' }], overview: 'Fixture', rubric: next.scenario.rubric.map(criterion => ({ criterionId: criterion.id, level: 'Developing', feedback: 'Fixture', evidenceIds: ['synthetic-evidence'], confidence: 'low' })), nextPractice: [] }] };
    expect(buildProgression([first, completed], drafts.map(toPublicScenario)).skills.every(skill => skill.history[0].conditions.exposure === 'repeated' && skill.freshObservations === 0)).toBe(true);
  });
  it('adds exact authored prerequisite lessons to a selected-goal plan without claiming completion', () => {
    const result = buildProgression([], drafts.map(toPublicScenario), { selectedCompetencies: ['count-validation'] });
    expect(result.studyPlan.steps[0]).toMatchObject({ scenarioId: 'stock-foundations' });
    const prerequisite = result.studyPlan.steps.find(step => step.kind === 'lesson');
    expect(prerequisite).toMatchObject({ id: 'lesson:correctness' });
    expect(prerequisite?.reason).toContain('No prerequisite completion or mastery is inferred');
    const unconfigured = withFoundryNavigation(result, { production: true });
    expect(unconfigured.studyPlan.steps.find(step => step.kind === 'lesson')?.navigation).toEqual({ status: 'unavailable', reason: 'not-configured' });
    const configured = withFoundryNavigation(result, { production: true, origin: 'https://foundry.example' });
    expect(configured.studyPlan.steps.find(step => step.kind === 'lesson')?.navigation).toEqual({ status: 'available', href: 'https://foundry.example/dsa/foundations/correctness' });
  });
});
