-- Voice uses the existing normalized quota ledger and its PostgresPracticeStore
-- advisory lock (843239117). Never store audio, transcripts or question text here.
-- Migration 0002 must already have added runtime_payload.
alter table public.ai_practice_usage_ledger
  add constraint ai_practice_voice_metadata check (
    not (runtime_payload ? 'voice') or (
      jsonb_typeof(runtime_payload->'voice') = 'object' and
      (runtime_payload->'voice') ?& array['version','key','operation','requestId','fingerprint','seconds','characters','reservedUsd','state'] and
      (runtime_payload->'voice'->>'version') = '1' and
      (runtime_payload->'voice'->>'operation') in ('transcribe','speak') and
      (runtime_payload->'voice'->>'state') in ('reserved','settled','uncertain') and
      (runtime_payload->'voice'->>'fingerprint') ~ '^[0-9a-f]{64}$' and
      length(runtime_payload->'voice'->>'key') between 1 and 80 and
      length(runtime_payload->'voice'->>'requestId') between 8 and 128 and
      jsonb_typeof(runtime_payload->'voice'->'seconds') = 'number' and
      (runtime_payload->'voice'->>'seconds')::numeric > 0 and
      (runtime_payload->'voice'->>'seconds')::numeric <= 120 and
      jsonb_typeof(runtime_payload->'voice'->'characters') = 'number' and
      (runtime_payload->'voice'->>'characters')::numeric between 0 and 1500 and
      jsonb_typeof(runtime_payload->'voice'->'reservedUsd') = 'number' and
      (runtime_payload->'voice'->>'reservedUsd')::numeric between 0 and 100 and
      ((kind = 'reservation' and runtime_payload->'voice'->>'state' = 'reserved') or
       (kind = 'settlement' and runtime_payload->'voice'->>'state' = 'settled') or
       (kind = 'uncertain' and runtime_payload->'voice'->>'state' = 'uncertain'))
    )
  );
create index ai_practice_voice_owner_day on public.ai_practice_usage_ledger(user_id, created_at)
  where runtime_payload ? 'voice';
create index ai_practice_voice_session on public.ai_practice_usage_ledger(opaque_session_id, created_at)
  where runtime_payload ? 'voice';
create unique index ai_practice_voice_request_once on public.ai_practice_usage_ledger(user_id, (runtime_payload->'voice'->>'requestId'))
  where runtime_payload ? 'voice' and runtime_payload->'voice'->>'state' = 'reserved';
comment on constraint ai_practice_voice_metadata on public.ai_practice_usage_ledger is
  'Content-free bounded speech admission postings only. Existing service-role/RLS policy applies. Reservations are not automatically refunded after ambiguous provider outcomes.';
