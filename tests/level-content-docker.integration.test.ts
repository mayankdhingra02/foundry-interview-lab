import { beforeAll, describe, expect, it } from 'vitest';
import { listPracticeScenarios } from '../lib/content/scenarios';
import { executeScenario } from '../lib/runtime/runner';
import type { Scenario } from '../lib/interview-practice/types';

// Run only on an explicitly approved isolated execution host. No fake process,
// host Python, image pulls, or provider calls. CI provisions the image first.
const realDocker = process.env.FOUNDRY_DOCKER_INTEGRATION === '1';
const packages = listPracticeScenarios().filter(scenario => scenario.curriculum);
function brokenApproach(scenario: Scenario): Record<string, string> {
  const files = structuredClone(scenario.referenceFiles);
  if (scenario.id === 'stock-foundations') {
    // Handles ordinary counts but incorrectly admits booleans as integers.
    files['inventory.py'] = files['inventory.py'].replaceAll('type(quantity) is not int', 'not isinstance(quantity, int)');
  } else if (scenario.id === 'stock-retries') {
    // Successful retries work, but denial no longer owns a durable identity.
    files['inventory.py'] = files['inventory.py'].replace(
      "                self.db.execute('INSERT INTO requests VALUES (?, ?, ?, ?)', (request_id, sku, quantity, int(result)))",
      "                if result:\n                    self.db.execute('INSERT INTO requests VALUES (?, ?, ?, ?)', (request_id, sku, quantity, int(result)))",
    );
  } else if (scenario.id === 'stock-lifecycle') {
    // Restoring stock without persisting the transition permits double restore.
    files['inventory.py'] = files['inventory.py'].replace("                self.db.execute('UPDATE requests SET active=0 WHERE request_id=?', (request_id,))", '                pass  # Broken: cancellation state is not persisted.');
  } else throw new Error('No authored broken approach for this qualification package.');
  if (files['inventory.py'] === scenario.referenceFiles['inventory.py']) throw new Error('Qualification mutation did not change the authored reference.');
  return files;
}

describe.runIf(realDocker)('three-level content through the real isolated runner', () => {
  beforeAll(() => {
    expect(process.env.PYTHON_IMAGE_ID, 'Provision and inspect the reviewed image before starting qualification.').toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it.each(packages)('reference satisfies both suites: $id', async scenario => {
    const result = await executeScenario(scenario, scenario.referenceFiles, { includeProtected: true });
    expect(result.status, result.stderr).toBe('completed');
    expect(result.exitCode, JSON.stringify(result.tests)).toBe(0);
    expect(result.tests.map(test => test.id)).toEqual(scenario.tests.map(test => test.id));
    expect(result.tests.every(test => test.status === 'passed'), JSON.stringify(result.tests)).toBe(true);
    expect(result.runtimeDigest).toBe(process.env.PYTHON_IMAGE_ID);
  }, 60_000);
  it.each(packages)('starter exposes a disclosed gap: $id', async scenario => {
    const result = await executeScenario(scenario, scenario.files, { includeProtected: true });
    expect(result.status, result.stderr).toBe('completed'); expect(result.exitCode).toBe(1);
    expect(result.tests.some(test => test.status === 'failed' || test.status === 'error'), JSON.stringify(result.tests)).toBe(true);
    expect(result.runtimeDigest).toBe(process.env.PYTHON_IMAGE_ID);
  }, 60_000);
  it.each(packages)('rejects a substantively broken approach: $id', async scenario => {
    const result = await executeScenario(scenario, brokenApproach(scenario), { includeProtected: true });
    expect(result.status, result.stderr).toBe('completed'); expect(result.exitCode).toBe(1);
    expect(result.tests.some(test => test.status === 'failed' || test.status === 'error'), JSON.stringify(result.tests)).toBe(true);
    expect(result.runtimeDigest).toBe(process.env.PYTHON_IMAGE_ID);
  }, 60_000);
});
