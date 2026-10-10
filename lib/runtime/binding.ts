import type { Scenario } from '../interview-practice/types';

export type RuntimeBinding = { version: 1; scenarioImage: string; imageAlias: string; imageId: string };
export const DEFAULT_SCENARIO_IMAGE = 'python:3.11-slim';
const imageName = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,200}$/;
export const immutableImageId = /^sha256:[a-f0-9]{64}$/;

/** Validate a previously admitted binding without reinterpreting current environment settings. */
export function parseRuntimeBinding(value: unknown, scenarioImage: string): RuntimeBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Partial<RuntimeBinding>;
  return binding.version === 1 && binding.scenarioImage === scenarioImage && typeof binding.imageAlias === 'string' && imageName.test(binding.imageAlias) && typeof binding.imageId === 'string' && immutableImageId.test(binding.imageId)
    ? { version: 1, scenarioImage, imageAlias: binding.imageAlias, imageId: binding.imageId } : null;
}

/** Trusted operator configuration only. Resolving a binding performs no Docker or network I/O. */
export function configuredRuntimeBinding(scenario: Pick<Scenario, 'runtime'>, env: Record<string, string | undefined> = process.env): RuntimeBinding | null {
  const scenarioImage = scenario.runtime.image, imageAlias = env.PYTHON_IMAGE || scenarioImage;
  const allowed = (env.RUNNER_ALLOWED_IMAGES || DEFAULT_SCENARIO_IMAGE).split(',').map(value => value.trim()).filter(Boolean);
  if (!imageName.test(scenarioImage) || !allowed.includes(scenarioImage) || !allowed.includes(imageAlias)) return null;
  return parseRuntimeBinding({ version: 1, scenarioImage, imageAlias, imageId: env.PYTHON_IMAGE_ID }, scenarioImage);
}

export function runtimeBindingConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(configuredRuntimeBinding({ runtime: { image: DEFAULT_SCENARIO_IMAGE, memoryMb: 128, timeoutSeconds: 30 } }, env));
}
