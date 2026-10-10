import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { getScenario, listScenarios, listScenarioSummaries } from '../lib/content/scenarios';
import { toPublicScenario } from '../lib/interview-practice/domain';
import type { Scenario } from '../lib/interview-practice/types';

const scenarios = listScenarios();

function runChecks(scenario: Scenario, reference: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-content-'));
  try {
    for (const [name, source] of Object.entries(reference ? scenario.referenceFiles : scenario.files)) {
      const target = join(directory, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    scenario.tests.forEach((test, index) => writeFileSync(join(directory, `test_${index}.py`), test.source));
    return spawnSync(process.env.FOUNDRY_PYTHON_BIN || 'python3', ['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py', '-v'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 256_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('original scenario catalog', () => {
  it('has five distinct complete packages with valid cross-references', () => {
    expect(scenarios.map(scenario => scenario.id)).toEqual(['monetary-validation', 'extension-compatibility', 'duplicate-invoice', 'inventory-reservations', 'event-rollup']);
    for (const scenario of scenarios) {
      expect(scenario.version).toBe('1.0.0');
      expect(scenario.tests.some(test => test.visible)).toBe(true);
      expect(scenario.tests.some(test => !test.visible)).toBe(true);
      expect(scenario.hints.length).toBeGreaterThanOrEqual(3);
      expect(scenario.probes.length).toBeGreaterThanOrEqual(3);
      expect(scenario.drills.length).toBeGreaterThanOrEqual(3);
      expect(scenario.files['README.md']).toContain('protected checks');
      for (const probe of scenario.probes) {
        expect(scenario.stages.some(stage => stage.id === probe.stageId)).toBe(true);
        expect(scenario.rubric.some(criterion => criterion.id === probe.competencyId)).toBe(true);
      }
      for (const criterion of scenario.rubric) {
        expect(scenario.drills.some(drill => drill.competencyId === criterion.id)).toBe(true);
      }
    }
  });

  it('never turns a user-supplied ID into a path or silently changes version', () => {
    expect(getScenario('../../.env')).toBeNull();
    expect(getScenario('duplicate-invoice', '99.0.0')).toBeNull();
    expect(getScenario('duplicate-invoice', '1.0.0')?.title).toBe('Duplicate Invoice Incident');
  });

  it('returns independent copies so one attempt cannot corrupt another package', () => {
    const scenario = getScenario('duplicate-invoice')!;
    scenario.files['service.py'] = 'corrupted';
    scenario.hints.pop();
    expect(getScenario('duplicate-invoice')!.files['service.py']).not.toBe('corrupted');
    expect(getScenario('duplicate-invoice')!.hints.length).toBe(3);
  });

  it('public transport excludes reference code, protected source, hints, and probes', () => {
    for (const scenario of scenarios) {
      const publicScenario = toPublicScenario(scenario);
      expect(publicScenario).not.toHaveProperty('referenceFiles');
      expect(publicScenario).not.toHaveProperty('hints');
      expect(publicScenario).not.toHaveProperty('probes');
      for (const test of publicScenario.tests) {
        expect(Object.hasOwn(test, 'source')).toBe(test.visible);
      }
      const summaries = listScenarioSummaries();
      expect(summaries.every(summary => !('files' in summary) && !('tests' in summary) && !('referenceFiles' in summary))).toBe(true);
    }
  });

  it.each(scenarios)('reference satisfies all disclosed checks: $id', scenario => {
    const result = runChecks(scenario, true);
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(/Ran [6-9] tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
  });

  const expectedFailures: Record<string, string> = {
    'monetary-validation': 'test_half_up',
    'extension-compatibility': 'test_filter_csv',
    'duplicate-invoice': 'test_identical_retry',
    'inventory-reservations': 'test_invalid_quantity',
    'event-rollup': 'test_utc_day',
  };
  it.each(scenarios)('starter exposes an intended contract gap: $id', scenario => {
    const result = runChecks(scenario, false);
    expect(result.error, result.error?.message).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`FAIL: ${expectedFailures[scenario.id]}`);
    expect(result.stderr).not.toMatch(/SyntaxError|ModuleNotFoundError|ImportError/);
  });
});
