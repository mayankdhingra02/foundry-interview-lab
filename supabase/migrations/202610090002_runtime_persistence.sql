-- Runtime storage for PostgresPracticeStore. Each entity remains a separate owner-constrained row.
-- runtime_payload preserves typed fields without a whole-database/session aggregate blob.
begin;
do $$
declare target text;
begin
  foreach target in array array['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_reports','ai_practice_requests','ai_practice_usage_ledger','ai_practice_deletions'] loop
    execute format('alter table public.%I add column runtime_payload jsonb not null default ''{}''::jsonb check (jsonb_typeof(runtime_payload) = ''object'' and octet_length(runtime_payload::text) <= 1048576)', target);
  end loop;
end $$;
alter table public.ai_practice_jobs add column runtime_sequence integer not null default 0 check (runtime_sequence >= 0);
alter table public.ai_practice_reports add column runtime_sequence integer not null default 0 check (runtime_sequence >= 0);

create table public.ai_practice_turns (
  id uuid primary key, session_id uuid not null, user_id uuid not null,
  role text not null check (role in ('learner','interviewer')),
  sequence integer not null check (sequence > 0),
  runtime_payload jsonb not null check (jsonb_typeof(runtime_payload) = 'object' and octet_length(runtime_payload::text) <= 32000),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  unique (session_id, sequence)
);
create table public.ai_practice_runs (
  id uuid primary key, session_id uuid not null, user_id uuid not null,
  job_id uuid not null, snapshot_id uuid not null,
  sequence integer not null check (sequence > 0),
  runtime_payload jsonb not null check (jsonb_typeof(runtime_payload) = 'object' and octet_length(runtime_payload::text) <= 262144),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  foreign key (job_id, session_id, user_id) references public.ai_practice_jobs(id, session_id, user_id),
  foreign key (snapshot_id, session_id, user_id) references public.ai_practice_snapshots(id, session_id, user_id),
  unique (session_id, sequence)
);
create table public.ai_practice_assistant_messages (
  id uuid primary key, session_id uuid not null, user_id uuid not null,
  role text not null check (role in ('learner','assistant')),
  sequence integer not null check (sequence > 0),
  runtime_payload jsonb not null check (jsonb_typeof(runtime_payload) = 'object' and octet_length(runtime_payload::text) <= 96000),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  unique (session_id, sequence)
);
create table public.ai_practice_edit_proposals (
  id uuid primary key, session_id uuid not null, user_id uuid not null,
  job_id uuid not null, snapshot_id uuid not null,
  sequence integer not null check (sequence > 0),
  status text not null check (status in ('pending','accepted','rejected')),
  runtime_payload jsonb not null check (jsonb_typeof(runtime_payload) = 'object' and octet_length(runtime_payload::text) <= 524288),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  foreign key (job_id, session_id, user_id) references public.ai_practice_jobs(id, session_id, user_id),
  foreign key (snapshot_id, session_id, user_id) references public.ai_practice_snapshots(id, session_id, user_id),
  unique (session_id, sequence)
);
create table public.ai_practice_evidence_manifests (
  session_id uuid primary key, user_id uuid not null,
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  event_watermark bigint not null check (event_watermark > 0),
  runtime_payload jsonb not null check (jsonb_typeof(runtime_payload) = 'object' and octet_length(runtime_payload::text) <= 1048576),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade
);

do $$
declare target text;
begin
  foreach target in array array['ai_practice_turns','ai_practice_runs','ai_practice_assistant_messages','ai_practice_edit_proposals','ai_practice_evidence_manifests'] loop
    execute format('alter table public.%I enable row level security', target);
    execute format('create policy "Owners read private practice records" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', target);
    execute format('revoke all on public.%I from anon, authenticated', target);
    execute format('grant select on public.%I to authenticated', target);
    execute format('grant select, insert, update, delete on public.%I to service_role', target);
  end loop;
end $$;
-- An event/report/snapshot is immutable after acknowledgement. Owners can delete a session via the trusted service.
create function public.ai_practice_reject_immutable_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new is distinct from old then raise exception 'Acknowledged practice evidence is immutable' using errcode = '23514'; end if;
  return new;
end $$;
create trigger ai_practice_snapshot_immutable before update on public.ai_practice_snapshots for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_event_immutable before update on public.ai_practice_events for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_report_immutable before update on public.ai_practice_reports for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_manifest_immutable before update on public.ai_practice_evidence_manifests for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_turn_immutable before update on public.ai_practice_turns for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_run_immutable before update on public.ai_practice_runs for each row execute function public.ai_practice_reject_immutable_update();
comment on table public.ai_practice_sessions is 'Normalized PostgresPracticeStore runtime. Serialized trusted-server transactions enforce CAS, idempotency, ledger admission and fencing; local disposable PostgreSQL qualification does not establish hosted performance.';
comment on column public.ai_practice_sessions.runtime_payload is 'Session metadata only. Child snapshots/events/jobs/reports/turns/runs and frozen evidence are separate rows.';
commit;
