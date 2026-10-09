import { digest, DomainError, textDigest } from './domain';
import { LEARNER_CHECK_POLICY as policy, type LearnerCheckBinding, type RunSelection } from './check-policy';
import type { Scenario, ScenarioTest } from './types';

export type SelectedRunSuite = { tests: ScenarioTest[]; learnerCheck?: LearnerCheckBinding };
export function selectRunSuite(scenario: Scenario, files: Record<string, string>, selection: RunSelection = 'authored'): SelectedRunSuite {
  if (selection === 'authored') return { tests: structuredClone(scenario.tests) };
  if (selection !== 'learner') throw new DomainError('invalid', 'Select authored contracts or your learner check.');
  if (Object.hasOwn(scenario.files, policy.path) || scenario.tests.some(test => test.id === policy.testId)) throw new DomainError('unavailable', 'This authored package conflicts with the reserved learner-check policy. Its original contracts are preserved.');
  const source = files[policy.path];
  if (typeof source !== 'string' || !source.trim() || source.includes('\0') || Buffer.byteLength(source) > policy.maxSourceBytes) throw new DomainError('invalid', 'Save a learner_checks.py unittest file of at most 8 KB before requesting its run.');
  return {
    tests: [{ id: policy.testId, title: 'Learner-authored regression check', source, visible: true, timeoutSeconds: policy.timeoutSeconds }],
    learnerCheck: { workspacePolicyVersion: 1, executionPolicyVersion: 1, path: policy.path, sourceSha256: textDigest(source) },
  };
}

/** Fail before execution if an immutable job no longer matches its snapshot/policy. */
export function admittedRunSuite(scenario: Scenario, files: Record<string, string>, input: Record<string, unknown>): SelectedRunSuite {
  if (input.selection !== undefined && input.selection !== 'learner') throw new DomainError('invalid', 'Admitted check selection is unsupported.');
  const suite = selectRunSuite(scenario, files, input.selection === 'learner' ? 'learner' : 'authored');
  if (input.testSuiteDigest !== digest(suite.tests) || (suite.learnerCheck ? digest(input.learnerCheck ?? null) !== digest(suite.learnerCheck) : input.learnerCheck !== undefined)) throw new DomainError('invalid', 'Admitted check source, suite or policy does not match its immutable workspace snapshot.');
  return suite;
}
