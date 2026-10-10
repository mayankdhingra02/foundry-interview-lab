import 'server-only';
import { digest, toPublicScenario } from '../interview-practice/domain';
import { isCurriculumLessonReference, type ScenarioPreparation, type ScenarioPrerequisite } from '../interview-practice/curriculum';
import type { PublicScenario, Scenario } from '../interview-practice/types';

// Immutable advisory sidecars for the five preserved packages. Never add these
// fields to the hydrated v1 package, saved session or benchmark context.
const lesson = (id: string, foundryPath: string) => ({ id, foundryPath });
const correctness = lesson('correctness', '/dsa/foundations/correctness');
const state = lesson('state-lifecycle-errors', '/low-level-design/lessons/state-lifecycle-errors');
const interfaces = lesson('relationships-interfaces', '/low-level-design/lessons/relationships-interfaces');
const ownership = lesson('responsibilities-ownership', '/low-level-design/lessons/responsibilities-ownership');
const concurrency = lesson('concurrency-testability-evolution', '/low-level-design/lessons/concurrency-testability-evolution');
const item = (id: string, title: string, description: string, reference: ScenarioPrerequisite['lesson']): ScenarioPrerequisite => ({ id, title, description, lesson: reference });
const records: Record<string, ScenarioPreparation> = {
  'monetary-validation': {
    version: '1', scenarioId: 'monetary-validation', scenarioVersion: '1.0.0', scenarioDigest: 'd3f2ac3863992c2b5f2cd2d9e11a0b99773d152c20e7c3dee14747ada9369a98', reviewStatus: 'draft',
    prerequisites: [
      item('money-boundary-tests', 'Trace arithmetic and boundary cases', 'Practise following a small function, writing expected results, and distinguishing a passing example from a verified contract.', correctness),
      item('money-input-errors', 'Validate inputs before changing state', 'Review Python type checks, integer arithmetic and how an invalid value should produce a clear error. The task brief defines the required monetary behavior.', state),
    ],
  },
  'extension-compatibility': {
    version: '1', scenarioId: 'extension-compatibility', scenarioVersion: '1.0.0', scenarioDigest: '7ed7b5ad9fee02413374026a5f15c1ea0708fea7dd09808632e7b48ff3d8c8d3', reviewStatus: 'draft',
    prerequisites: [
      item('extension-interface-contracts', 'Read and preserve public interfaces', 'Identify callers, accepted inputs and return values before extending a module. Practise explaining which existing behavior must remain compatible.', interfaces),
      item('extension-regressions', 'Write focused regression checks', 'Compare the old and new behavior with examples that cover both the added path and existing callers.', correctness),
    ],
  },
  'duplicate-invoice': {
    version: '1', scenarioId: 'duplicate-invoice', scenarioVersion: '1.0.0', scenarioDigest: '32cf761542641adc896bf8b95276f5c33dbd0ee9c2f221f7f6f663aafe4554fe', reviewStatus: 'draft',
    prerequisites: [
      item('invoice-state-and-retries', 'Reason about persistent state and retries', 'Review how application state differs from database state, and how to describe a repeated request and a rejected request. Be comfortable reading simple SQLite operations.', state),
      item('invoice-module-boundaries', 'Trace responsibility across modules', 'Follow one request through a model, service and storage module. Identify which layer owns validation, persistence and the public response.', ownership),
      item('invoice-recovery-tests', 'Test recovery as a sequence', 'Practise writing a test with setup, an operation, a failure or restart, and an observable final assertion.', correctness),
    ],
  },
  'inventory-reservations': {
    version: '1', scenarioId: 'inventory-reservations', scenarioVersion: '1.0.0', scenarioDigest: 'fbad580a10702b71c855b025ba69202fdc3a76b47bb99f8135ef109971ae3b0e', reviewStatus: 'draft',
    prerequisites: [
      item('inventory-concurrent-operations', 'Explain concurrent state changes', 'Practise describing two operations that overlap and the invariant each must preserve. Review transaction boundaries and contention without assuming one implementation is required.', concurrency),
      item('inventory-failure-invariants', 'Specify state after rejection', 'Explain which state must survive a failed operation, then write a check that inspects it. Be comfortable reading the task’s standard-library SQLite code.', state),
    ],
  },
  'event-rollup': {
    version: '1', scenarioId: 'event-rollup', scenarioVersion: '1.0.0', scenarioDigest: '1d44d0cb79bc1a694e7d19051a20ddbb3bf2a9194c41dfc8a75ff2a0c581300f', reviewStatus: 'draft',
    prerequisites: [
      item('rollup-repository-tracing', 'Trace data across an unfamiliar repository', 'Follow a small input through parsing, transformation and aggregation. Identify the responsibility and observable output of each module.', ownership),
      item('rollup-contract-boundaries', 'Test boundaries between stages', 'Practise choosing representative and invalid inputs, stating expected outputs, and checking that a change in one stage preserves the surrounding contracts.', correctness),
    ],
  },
};

/** Catalog/progression projection only. An edited or unknown package never
 * inherits preparation written for a different contract. */
export function withScenarioPreparation(scenario: Scenario): PublicScenario {
  const published = toPublicScenario(scenario);
  const guidance = Object.hasOwn(records, scenario.id) ? records[scenario.id] : undefined;
  if (!guidance || guidance.scenarioVersion !== scenario.version || guidance.scenarioDigest !== digest(scenario)) return published;
  if (!guidance.prerequisites.length || guidance.prerequisites.some(row => row.lesson && !isCurriculumLessonReference(row.lesson.id, row.lesson.foundryPath))) throw new Error('Invalid authored preparation guidance.');
  return { ...published, preparation: structuredClone(guidance) };
}
