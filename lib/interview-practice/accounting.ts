import { DomainError } from './domain';
import type { LedgerEntry } from './types';

export const DURABLE_ACCOUNTING_POLICY = { version: 'durable-usage-v1', maximumPostingBytes: 8192 } as const;
const fields = ['id', 'ownerId', 'sessionId', 'operationId', 'kind', 'amountUsd', 'createdAt', 'budgetAt', 'voice'];
const voiceFields = ['version', 'key', 'operation', 'requestId', 'fingerprint', 'seconds', 'characters', 'reservedUsd', 'state', 'expiresAt'];
const invalid = () => new DomainError('unavailable', 'Budget usage records need operator review. Existing commitments were preserved.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
function instant(value: unknown): number {
  if (!bounded(value, 64) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid();
  const result = Date.parse(value); if (!Number.isFinite(result)) throw invalid(); return result;
}

/** A retained posting contains operational identities and amounts, never learner/provider content.
 * UUIDs, request fingerprints and timestamps remain linkable metadata, not anonymous data. */
export function assertContentFreePosting(value: unknown): asserts value is LedgerEntry {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key))) throw invalid();
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); } catch { throw invalid(); }
  if (bytes > DURABLE_ACCOUNTING_POLICY.maximumPostingBytes || !bounded(value.id, 128) || !bounded(value.ownerId, 128) || !bounded(value.sessionId, 128) || !bounded(value.operationId, 160)
    || !['admission', 'reservation', 'settlement', 'uncertain'].includes(String(value.kind)) || typeof value.amountUsd !== 'number' || !Number.isFinite(value.amountUsd) || Math.abs(value.amountUsd) > 100 || value.kind !== 'settlement' && value.amountUsd < 0) throw invalid();
  const at = instant(value.createdAt);
  if (value.budgetAt !== undefined && (instant(value.budgetAt) !== at && value.kind === 'reservation')) throw invalid();
  if (value.voice === undefined) return;
  const voice = value.voice;
  if (!object(voice) || Object.keys(voice).some(key => !voiceFields.includes(key)) || voice.version !== 1 || !bounded(voice.key, 80) || !/^voice:[a-zA-Z0-9_-]{1,70}$/.test(voice.key)
    || !['transcribe', 'speak'].includes(String(voice.operation)) || !bounded(voice.requestId, 128) || !/^[a-zA-Z0-9_-]{8,128}$/.test(voice.requestId) || typeof voice.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(voice.fingerprint)
    || typeof voice.seconds !== 'number' || !Number.isFinite(voice.seconds) || voice.seconds <= 0 || voice.seconds > 120 || !Number.isSafeInteger(voice.characters) || Number(voice.characters) < 0 || Number(voice.characters) > 1500
    || typeof voice.reservedUsd !== 'number' || !Number.isFinite(voice.reservedUsd) || voice.reservedUsd < 0 || voice.reservedUsd > 100 || !['reserved', 'settled', 'uncertain'].includes(String(voice.state))
    || value.operationId !== `${voice.key}:${voice.state}` || (value.kind === 'reservation' ? voice.state !== 'reserved' || value.amountUsd !== voice.reservedUsd : value.kind === 'settlement' ? voice.state !== 'settled' || value.amountUsd !== 0 : value.kind !== 'uncertain' || voice.state !== 'uncertain' || value.amountUsd !== 0)) throw invalid();
  if (voice.expiresAt !== undefined && instant(voice.expiresAt) < at && value.kind === 'reservation') throw invalid();
}

/** Exact reviewed CHECK expression, shared with catalog validation. The migration
 * is append-only; its literal expression is checked by an offline regression. */
export const DURABLE_USAGE_CHECK_SQL = `coalesce(
  jsonb_typeof(runtime_payload) = 'object'
  and octet_length(runtime_payload::text) <= 8192
  and runtime_payload ?& array['id','ownerId','sessionId','operationId','kind','amountUsd','createdAt']
  and runtime_payload - array['id','ownerId','sessionId','operationId','kind','amountUsd','createdAt','budgetAt','voice'] = '{}'::jsonb
  and jsonb_typeof(runtime_payload->'id') = 'string' and runtime_payload->>'id' = id::text
  and jsonb_typeof(runtime_payload->'ownerId') = 'string' and runtime_payload->>'ownerId' = user_id::text
  and jsonb_typeof(runtime_payload->'sessionId') = 'string' and runtime_payload->>'sessionId' = opaque_session_id::text
  and jsonb_typeof(runtime_payload->'operationId') = 'string' and runtime_payload->>'operationId' = operation_id and length(operation_id) >= 1 and length(operation_id) <= 160
  and jsonb_typeof(runtime_payload->'kind') = 'string' and runtime_payload->>'kind' = kind
  and jsonb_typeof(runtime_payload->'amountUsd') = 'number' and (runtime_payload->>'amountUsd')::numeric(12,8) = amount_usd and abs(amount_usd) <= 100
  and (kind = 'settlement' or amount_usd >= 0)
  and jsonb_typeof(runtime_payload->'createdAt') = 'string' and length(runtime_payload->>'createdAt') >= 1 and length(runtime_payload->>'createdAt') <= 64 and (runtime_payload->>'createdAt')::timestamptz = created_at
  and (not (runtime_payload ? 'budgetAt') or (jsonb_typeof(runtime_payload->'budgetAt') = 'string' and length(runtime_payload->>'budgetAt') >= 1 and length(runtime_payload->>'budgetAt') <= 64 and (runtime_payload->>'budgetAt')::timestamptz is not null and (kind <> 'reservation' or (runtime_payload->>'budgetAt')::timestamptz = created_at)))
  and (not (runtime_payload ? 'voice') or (
    jsonb_typeof(runtime_payload->'voice') = 'object'
    and (runtime_payload->'voice') ?& array['version','key','operation','requestId','fingerprint','seconds','characters','reservedUsd','state']
    and (runtime_payload->'voice') - array['version','key','operation','requestId','fingerprint','seconds','characters','reservedUsd','state','expiresAt'] = '{}'::jsonb
    and jsonb_typeof(runtime_payload->'voice'->'version') = 'number' and runtime_payload->'voice'->>'version' = '1'
    and jsonb_typeof(runtime_payload->'voice'->'key') = 'string' and runtime_payload->'voice'->>'key' ~ '^voice:[a-zA-Z0-9_-]{1,70}$'
    and jsonb_typeof(runtime_payload->'voice'->'operation') = 'string' and runtime_payload->'voice'->>'operation' = any(array['transcribe','speak'])
    and jsonb_typeof(runtime_payload->'voice'->'requestId') = 'string' and runtime_payload->'voice'->>'requestId' ~ '^[a-zA-Z0-9_-]{8,128}$'
    and jsonb_typeof(runtime_payload->'voice'->'fingerprint') = 'string' and runtime_payload->'voice'->>'fingerprint' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(runtime_payload->'voice'->'seconds') = 'number' and (runtime_payload->'voice'->>'seconds')::numeric > 0 and (runtime_payload->'voice'->>'seconds')::numeric <= 120
    and jsonb_typeof(runtime_payload->'voice'->'characters') = 'number' and (runtime_payload->'voice'->>'characters')::numeric >= 0 and (runtime_payload->'voice'->>'characters')::numeric <= 1500 and (runtime_payload->'voice'->>'characters')::numeric = trunc((runtime_payload->'voice'->>'characters')::numeric)
    and jsonb_typeof(runtime_payload->'voice'->'reservedUsd') = 'number' and (runtime_payload->'voice'->>'reservedUsd')::numeric >= 0 and (runtime_payload->'voice'->>'reservedUsd')::numeric <= 100
    and jsonb_typeof(runtime_payload->'voice'->'state') = 'string'
    and operation_id = (runtime_payload->'voice'->>'key') || ':' || (runtime_payload->'voice'->>'state')
    and ((kind = 'reservation' and runtime_payload->'voice'->>'state' = 'reserved' and (runtime_payload->'voice'->>'reservedUsd')::numeric(12,8) = amount_usd) or (kind = 'settlement' and runtime_payload->'voice'->>'state' = 'settled' and amount_usd = 0) or (kind = 'uncertain' and runtime_payload->'voice'->>'state' = 'uncertain' and amount_usd = 0))
    and (not ((runtime_payload->'voice') ? 'expiresAt') or (jsonb_typeof(runtime_payload->'voice'->'expiresAt') = 'string' and length(runtime_payload->'voice'->>'expiresAt') >= 1 and length(runtime_payload->'voice'->>'expiresAt') <= 64 and (runtime_payload->'voice'->>'expiresAt')::timestamptz is not null))
  )), false)`;

/** PostgreSQL deparses harmless casts/parentheses differently from source SQL.
 * Preserve identifiers, literal case, operators and every predicate. */
export function accountingCheckContract(definition: string): string {
  return definition.replace(/^CHECK\s*/i, '').replace(/::timestamp\s+with\s+time\s+zone/gi, '::timestamptz')
    .replace(/::(?:text|jsonb|numeric(?!\s*\())\b/g, '').replace(/\b(?:COALESCE|ARRAY|ANY|AND|OR|NOT|BETWEEN|IS|NULL)\b/g, keyword => keyword.toLowerCase()).replace(/\s+|[()]/g, '');
}
