/** Conservative admission bound: at most one billed token per UTF-8 input byte,
 * plus schema/instruction allowance. Prices are deployment configuration, not a quote. */
export const INPUT_BYTES = { interviewer: 24_000, assistant: 64_000, coach: 64_000 } as const;
export type AiRole = keyof typeof INPUT_BYTES;
export type ModelProvider = 'openai-responses' | 'anthropic-messages';
export type ModelPolicy = { provider: ModelProvider; model: string; inputRate: number; outputRate: number; maxOutput: number };

/** Operator selection only. An invalid value must not silently select a provider. */
export function configuredProvider(): ModelProvider {
  const provider = process.env.AI_PROVIDER;
  if (provider === undefined) return 'openai-responses';
  if (provider === 'openai-responses' || provider === 'anthropic-messages') return provider;
  throw new Error('Invalid AI provider selection.');
}

/** Availability is checked for the admitted provider, including its kill switch. */
export function providerAvailable(provider: ModelProvider): boolean {
  if (provider === 'openai-responses') return Boolean(process.env.OPENAI_API_KEY?.trim());
  if (provider === 'anthropic-messages') return process.env.FEATURE_ANTHROPIC_INFERENCE === 'true' && Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return false;
}

export function modelPolicy(): ModelPolicy {
  const provider = configuredProvider();
  const anthropic = provider === 'anthropic-messages';
  const model = anthropic ? process.env.ANTHROPIC_MODEL : process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const configuredInput = anthropic ? process.env.ANTHROPIC_INPUT_USD_PER_MILLION : process.env.OPENAI_INPUT_USD_PER_MILLION;
  const configuredOutput = anthropic ? process.env.ANTHROPIC_OUTPUT_USD_PER_MILLION : process.env.OPENAI_OUTPUT_USD_PER_MILLION;
  if (anthropic && (!model || !configuredInput?.trim() || !configuredOutput?.trim())) throw new Error('Configure the Anthropic model and both prices explicitly.');
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) throw new Error('Invalid model identifier.');
  if (!anthropic && model !== 'gpt-5.4-mini' && (!configuredInput?.trim() || !configuredOutput?.trim())) throw new Error('Configure prices when selecting a different model.');
  const inputRate = Number(configuredInput || '0.75');
  const outputRate = Number(configuredOutput || '4.5');
  const maxOutput = Number(process.env.AI_MAX_OUTPUT_TOKENS || 2400);
  if (![inputRate, outputRate].every(n => Number.isFinite(n) && n >= 0 && n <= 1000) || !Number.isSafeInteger(maxOutput) || maxOutput < 600 || maxOutput > 3200) throw new Error('Invalid model cost or output bounds.');
  return { provider, model, inputRate, outputRate, maxOutput };
}
export function inferenceReservations() {
  const policy = modelPolicy();
  const reserve = (role: AiRole) => Math.ceil(((INPUT_BYTES[role] + 8000) * policy.inputRate + policy.maxOutput * policy.outputRate) / 1_000_000 * 1_000_000) / 1_000_000;
  return { interviewer: reserve('interviewer'), assistant: reserve('assistant'), coach: reserve('coach') };
}
