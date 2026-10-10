/** Conservative admission bound: at most one billed token per UTF-8 input byte,
 * plus schema/instruction allowance. Prices are deployment configuration, not a quote. */
export const INPUT_BYTES = { interviewer: 24_000, assistant: 64_000, coach: 64_000 } as const;
export type AiRole = keyof typeof INPUT_BYTES;
export function modelPolicy() {
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  if (model !== 'gpt-5.4-mini' && (!process.env.OPENAI_INPUT_USD_PER_MILLION || !process.env.OPENAI_OUTPUT_USD_PER_MILLION)) throw new Error('Configure prices when selecting a different model.');
  const inputRate = Number(process.env.OPENAI_INPUT_USD_PER_MILLION || '0.75');
  const outputRate = Number(process.env.OPENAI_OUTPUT_USD_PER_MILLION || '4.5');
  const maxOutput = Number(process.env.AI_MAX_OUTPUT_TOKENS || 2400);
  if (![inputRate, outputRate].every(n => Number.isFinite(n) && n >= 0 && n <= 1000) || !Number.isSafeInteger(maxOutput) || maxOutput < 600 || maxOutput > 3200) throw new Error('Invalid model cost or output bounds.');
  return { model, inputRate, outputRate, maxOutput };
}
export function inferenceReservations() {
  const policy = modelPolicy();
  const reserve = (role: AiRole) => Math.ceil(((INPUT_BYTES[role] + 8000) * policy.inputRate + policy.maxOutput * policy.outputRate) / 1_000_000 * 1_000_000) / 1_000_000;
  return { interviewer: reserve('interviewer'), assistant: reserve('assistant'), coach: reserve('coach') };
}
