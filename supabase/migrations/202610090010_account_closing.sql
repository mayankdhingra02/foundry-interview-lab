-- Permanent account lifecycle fence, separate from reusable Lab content deletion.
-- No auth/session FK: the fence and cleanup inventory survive Auth cascades.
begin;
create table public.ai_practice_account_closings (
  opaque_owner_id uuid primary key,
  request_id text not null check (request_id ~ '^[a-zA-Z0-9_-]{8,128}$'),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  cleanup_id uuid not null references public.ai_practice_deletions(id) on delete restrict,
  created_at timestamptz not null,
  runtime_payload jsonb not null check (jsonb_typeof(runtime_payload) = 'object' and octet_length(runtime_payload::text) <= 4096)
);
alter table public.ai_practice_account_closings enable row level security;
revoke all on public.ai_practice_account_closings from public, anon, authenticated;
grant select, insert, update on public.ai_practice_account_closings to service_role;

create function public.ai_practice_keep_account_closing()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'Permanent account closing cannot be removed' using errcode = '23514'; end if;
  if tg_op = 'UPDATE' and new is distinct from old then raise exception 'Permanent account closing cannot change' using errcode = '23514'; end if;
  perform pg_catalog.pg_advisory_xact_lock(843239117::bigint);
  return new;
end $$;
create trigger ai_practice_account_closing_guard before insert or update or delete on public.ai_practice_account_closings for each row execute function public.ai_practice_keep_account_closing();

create function public.ai_practice_reject_closing_owner()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(843239117::bigint);
  if exists (select 1 from public.ai_practice_account_closings where opaque_owner_id = new.user_id) then
    raise exception 'Practice account is closing' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger ai_practice_session_account_open before insert or update on public.ai_practice_sessions for each row execute function public.ai_practice_reject_closing_owner();
create trigger ai_practice_job_account_open before insert or update on public.ai_practice_jobs for each row execute function public.ai_practice_reject_closing_owner();
create trigger ai_practice_snapshot_account_open before insert or update on public.ai_practice_snapshots for each row execute function public.ai_practice_reject_closing_owner();
create trigger ai_practice_artifact_account_open before insert or update on public.ai_practice_artifacts for each row execute function public.ai_practice_reject_closing_owner();
revoke all on function public.ai_practice_keep_account_closing() from public, anon, authenticated;
revoke all on function public.ai_practice_reject_closing_owner() from public, anon, authenticated;
comment on table public.ai_practice_account_closings is 'Permanent opaque owner fence; not an Auth deletion acknowledgment. No normal runtime reopening or expiry. Referenced private cleanup inventory survives Auth cascade.';
commit;
