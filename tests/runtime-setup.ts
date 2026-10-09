import { vi } from 'vitest';
import type * as Binding from '../lib/runtime/binding';

// Mock the trusted configuration boundary only in tests. No synthetic ID is
// put into process.env, shipped application config, or real Docker admission.
vi.mock('../lib/runtime/binding', async importOriginal => {
  const actual = await importOriginal<typeof Binding>();
  const fixture = await import('./runtime-fixtures');
  const integration = process.env.RUN_POSTGRES_INTEGRATION === '1' || process.env.FOUNDRY_DOCKER_INTEGRATION === '1';
  if (integration && !actual.immutableImageId.test(process.env.PYTHON_IMAGE_ID || '')) throw new Error('Opt-in SQL/Docker tests require the actual reviewed PYTHON_IMAGE_ID exported before Vitest starts.');
  return {
    ...actual,
    configuredRuntimeBinding: (scenario: Parameters<typeof actual.configuredRuntimeBinding>[0], env = process.env) => env === process.env && env.PYTHON_IMAGE_ID === undefined && !integration ? fixture.fixtureRuntimeBinding(scenario) : actual.configuredRuntimeBinding(scenario,env),
    runtimeBindingConfigured: (env = process.env) => env === process.env && env.PYTHON_IMAGE_ID === undefined && !integration ? true : actual.runtimeBindingConfigured(env),
  };
});
