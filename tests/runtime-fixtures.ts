import type { Scenario } from '../lib/interview-practice/types';
import type { RuntimeBinding } from '../lib/runtime/binding';

// Synthetic ID only for deterministic service/fake-Docker tests. Never a
// production config fallback. Opt-in suites must supply the real inspected ID.
export const syntheticRuntimeId = `sha256:${'a'.repeat(64)}`;
export const fixtureRuntimeId = process.env.PYTHON_IMAGE_ID || syntheticRuntimeId;
export const fixtureRuntimeBinding = (scenario: Pick<Scenario,'runtime'>): RuntimeBinding => ({ version: 1,scenarioImage: scenario.runtime.image,imageAlias: scenario.runtime.image,imageId: fixtureRuntimeId });
