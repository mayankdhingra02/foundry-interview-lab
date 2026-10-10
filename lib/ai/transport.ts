import type { InferenceRecord } from '../interview-practice/types';
import { compatibleInferenceBinding, type InferenceBinding } from './binding';

export class ProviderFailure extends Error {
  constructor(public readonly mayHaveBilled: boolean, public readonly inference?: InferenceRecord,
    public readonly category?: 'privacy_input' | 'cancelled' | 'network' | 'http' | 'response', public readonly status?: number) {
    super('Model inference could not finish.');
  }
}

/** Requests are data only. The product grants neither provider any executable tools. */
export type NormalizedToolRequest = { id?: string; name?: string; input: unknown };
export type NormalizedModelResponse = {
  text: string; toolRequests: NormalizedToolRequest[];
  finish: 'completed' | 'incomplete' | 'refused' | 'tool-request'; contentValid: boolean;
  inputTokens: number | null; outputTokens: number | null; usageKnown: boolean;
  returnedModel: string | null; providerRequestId?: string; responseId?: string;
};
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : undefined;
const zeroOrAbsent = (value: unknown) => value === undefined || value === null || count(value) === 0;
function zeroMeters(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const fields = object(value);
  return fields !== null && Object.values(fields).every(value => count(value) === 0);
}

function normalize(provider: InferenceBinding['provider'], value: unknown, headers: Headers): NormalizedModelResponse {
  const body = object(value) ?? {}, usage = object(body.usage), inputTokens = count(usage?.input_tokens), outputTokens = count(usage?.output_tokens);
  let usageKnown = inputTokens !== null && outputTokens !== null;
  let contentValid = true, refused = false;
  const texts: string[] = [], toolRequests: NormalizedToolRequest[] = [];
  const returnedModel = typeof body.model === 'string' && body.model.length > 0 && body.model.length <= 200 ? body.model : null;
  if (provider === 'anthropic-messages') {
    // No cache, server tools, priority tier or multi-iteration billing is requested.
    // A response that nevertheless meters these cannot be priced by two ordinary-token rates.
    usageKnown &&= zeroOrAbsent(usage?.cache_creation_input_tokens) && zeroOrAbsent(usage?.cache_read_input_tokens)
      && zeroMeters(usage?.cache_creation) && zeroMeters(usage?.server_tool_use)
      && (usage?.service_tier === undefined || usage.service_tier === 'standard')
      && (usage?.inference_geo === undefined || usage.inference_geo === 'global')
      && (usage?.speed === undefined || usage.speed === 'standard')
      && (usage?.iterations === undefined || Array.isArray(usage.iterations) && usage.iterations.length === 0);
    contentValid = (body.type === undefined || body.type === 'message') && (body.role === undefined || body.role === 'assistant');
    refused = body.stop_reason === 'refusal' || object(body.stop_details)?.type === 'refusal';
    if (!Array.isArray(body.content)) contentValid = false;
    else for (const raw of body.content) {
      const block = object(raw);
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
      else if (block?.type === 'tool_use') toolRequests.push({ id: identifier(block.id), name: identifier(block.name), input: block.input });
      else if (block?.type === 'server_tool_use') { usageKnown = false; contentValid = false; }
      else if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') contentValid = false;
    }
  } else {
    if (!Array.isArray(body.output)) contentValid = false;
    else for (const raw of body.output) {
      const item = object(raw);
      if (!item) { contentValid = false; continue; }
      if (item.type === 'function_call') {
        let input: unknown = item.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* Normalize malformed arguments as inert data. */ } }
        toolRequests.push({ id: identifier(item.call_id ?? item.id), name: identifier(item.name), input });
      } else if (typeof item.type === 'string' && item.type.endsWith('_call')) { usageKnown = false; contentValid = false; }
      else if (item.type !== 'reasoning') {
        if (!Array.isArray(item.content)) { contentValid = false; continue; }
        for (const raw of item.content) {
          const block = object(raw);
          if (block?.type === 'output_text' && typeof block.text === 'string') texts.push(block.text);
          else if (block?.type === 'refusal') refused = true;
          else contentValid = false;
        }
      }
    }
  }
  const completed = provider === 'anthropic-messages' ? body.stop_reason === 'end_turn' : body.status === 'completed';
  return { text: texts.join(''), toolRequests, finish: toolRequests.length ? 'tool-request' : refused ? 'refused' : completed ? 'completed' : 'incomplete',
    contentValid, inputTokens, outputTokens, usageKnown, returnedModel,
    providerRequestId: identifier(headers.get(provider === 'anthropic-messages' ? 'request-id' : 'x-request-id')), responseId: identifier(body.id) };
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderFailure(true, undefined, 'response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ProviderFailure(true, undefined, 'cancelled');
      const part = await reader.read();
      if (signal.aborted) throw new ProviderFailure(true, undefined, 'cancelled');
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > maximum) { await reader.cancel(); throw new ProviderFailure(true, undefined, 'response'); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure(true, undefined, signal.aborted ? 'cancelled' : 'response');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Exactly one request to the admitted provider. No retries, provider switching or tool execution. */
export async function requestStructuredModel(policy: InferenceBinding, instructions: string, input: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<NormalizedModelResponse> {
  if (signal?.aborted) throw new ProviderFailure(false, undefined, 'cancelled');
  if (!compatibleInferenceBinding(policy, policy.role)) throw new ProviderFailure(false);
  const anthropic = policy.provider === 'anthropic-messages';
  const key = anthropic ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  if (!key?.trim() || anthropic && process.env.FEATURE_ANTHROPIC_INFERENCE !== 'true') throw new ProviderFailure(false);
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const body = anthropic
    ? { model: policy.model, max_tokens: policy.maxOutputTokens, stream: false, service_tier: 'standard_only', system: instructions,
      messages: [{ role: 'user', content: input }], output_config: { format: { type: 'json_schema', schema } } }
    : { model: policy.model, store: false, max_output_tokens: policy.maxOutputTokens, instructions,
      input: [{ role: 'user', content: input }], text: { format: { type: 'json_schema', name: `foundry_${policy.role}`, strict: true, schema } } };
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]) : AbortSignal.timeout(policy.timeoutMs);
  let response: Response;
  try {
    response = await fetch(anthropic ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses', {
      method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'error'
    });
  } catch { throw new ProviderFailure(true, undefined, requestSignal.aborted ? 'cancelled' : 'network'); }
  if (!response.ok) {
    // Error bodies may contain submitted material; never import or log vendor error text.
    try { await response.body?.cancel(); } catch { /* The safe HTTP classification is already known. */ }
    throw new ProviderFailure(response.status >= 500 || response.status === 408, undefined, 'http', response.status);
  }
  return normalize(policy.provider, await readBounded(response, policy.maxResponseBytes, requestSignal), response.headers);
}
