-- One authoritative, content-free usage ledger survives permanent Auth deletion.
-- UUID owners remain linkable operational identities, not anonymous records.
-- Existing rows are validated before changing any FK or privileges; no rewrite,
-- provider call, inferred refund or automatic retention is performed.
begin;
do $$
begin
  if (select count(*) from pg_catalog.pg_constraint where conrelid='public.ai_practice_usage_ledger'::regclass and contype='f') <> 1
    or not exists (select 1 from pg_catalog.pg_constraint where conrelid='public.ai_practice_usage_ledger'::regclass and conname='ai_practice_usage_ledger_user_id_fkey' and contype='f' and confrelid='auth.users'::regclass and confdeltype='c' and conkey=array[(select attnum from pg_catalog.pg_attribute where attrelid='public.ai_practice_usage_ledger'::regclass and attname='user_id')] and confkey=array[(select attnum from pg_catalog.pg_attribute where attrelid='auth.users'::regclass and attname='id')])
    then raise exception 'Expected usage ledger Auth constraint is unavailable' using errcode='23514'; end if;
end $$;
alter table public.ai_practice_usage_ledger add constraint ai_practice_usage_content_free check (coalesce(
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
  )), false));
alter table public.ai_practice_usage_ledger drop constraint ai_practice_usage_ledger_user_id_fkey;
alter table public.ai_practice_usage_ledger enable row level security;
drop policy "Owners read private practice records" on public.ai_practice_usage_ledger;
revoke all on public.ai_practice_usage_ledger from public, anon, authenticated, service_role;
-- Table revocation does not revoke independent column privileges.
do $$
declare columns text;
begin
  select string_agg(pg_catalog.quote_ident(attname),',' order by attnum) into columns from pg_catalog.pg_attribute where attrelid='public.ai_practice_usage_ledger'::regclass and attnum>0 and not attisdropped;
  execute 'revoke select (' || columns || '), insert (' || columns || '), update (' || columns || '), references (' || columns || ') on public.ai_practice_usage_ledger from public, anon, authenticated, service_role';
end $$;
grant select, insert, update, delete on public.ai_practice_usage_ledger to service_role;
create trigger ai_practice_usage_immutable before update on public.ai_practice_usage_ledger for each row execute function public.ai_practice_reject_immutable_update();
comment on table public.ai_practice_usage_ledger is 'Durable service-only, content-free operational quota postings; opaque UUID owner and original reservation budget windows survive Auth/session deletion. Uncertain commitments are not refunded or expired automatically. Qualified bounded whole-group settled retention is separate.';
comment on constraint ai_practice_usage_content_free on public.ai_practice_usage_ledger is 'durable-usage-v1: bounded allowlisted identity/amount/time/voice allocation metadata only; no learner contents or provider bodies.';
commit;
