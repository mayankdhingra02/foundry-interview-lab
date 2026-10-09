-- Proposed normalized Supabase persistence topology. The initial runtime uses PracticeStore adapters.
-- These tables are NOT a claim that normalized admission/worker RPCs or hosted RLS have been qualified.
-- Apply in staging; implement/qualify transactional adapter RPCs before enabling public writes.
begin;

create table public.practice_scenario_versions (
  scenario_id text not null, version text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  published boolean not null default false, created_at timestamptz not null default now(),
  primary key (scenario_id, version)
);
comment on column public.practice_scenario_versions.manifest is 'Sanitized public manifest only. No references, private test source, probe bank, hints or learner data.';

create table public.ai_practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scenario_id text not null, scenario_version text not null,
  scenario_sha256 text not null check (scenario_sha256 ~ '^[a-f0-9]{64}$'),
  mode text not null check (mode in ('practice','simulation')),
  lifecycle text not null default 'active' check (lifecycle in ('active','paused','reviewing','completed')),
  stage_id text not null,
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  prompt_exposure text not null check (prompt_exposure in ('fresh','repeated')),
  revision bigint not null default 0 check (revision >= 0),
  code_frozen_snapshot_id uuid, final_evidence_digest text,
  final_event_watermark bigint check (final_event_watermark is null or final_event_watermark >= 0),
  consent_version text not null, deleted_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (scenario_id, scenario_version) references public.practice_scenario_versions(scenario_id, version),
  check (final_evidence_digest is null or final_evidence_digest ~ '^[a-f0-9]{64}$'),
  check ((final_evidence_digest is null) = (final_event_watermark is null)),
  check (lifecycle not in ('reviewing','completed') or (code_frozen_snapshot_id is not null and final_evidence_digest is not null))
);
create index ai_practice_owner_history on public.ai_practice_sessions(user_id, created_at desc, id);

create table public.ai_practice_snapshots (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, user_id uuid not null,
  sequence bigint not null check (sequence > 0),
  files jsonb, storage_key text,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  byte_count integer not null check (byte_count between 0 and 256000),
  created_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  unique (session_id, sequence), unique (id, session_id, user_id),
  check ((files is not null and jsonb_typeof(files) = 'object') or storage_key is not null)
);
alter table public.ai_practice_sessions add constraint ai_practice_frozen_snapshot_owner_fk
  foreign key (code_frozen_snapshot_id, id, user_id) references public.ai_practice_snapshots(id, session_id, user_id) deferrable initially deferred;

create table public.ai_practice_events (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, user_id uuid not null,
  sequence bigint not null check (sequence > 0), schema_version integer not null check (schema_version = 1),
  event_type text not null check (event_type in ('session.started','workspace.saved','stage.changed','coding.finished','session.paused','session.resumed','session.submitted','test.requested','test.completed','interviewer.question','learner.answer-committed','assistant.requested','assistant.responded','assistant.edit-decided','coaching.ready','operation.failed','job.cancelled','hint.opened','drill.completed')),
  source text not null check (source in ('learner','server','runner','model')),
  request_id text not null check (char_length(request_id) between 8 and 128),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 128000),
  occurred_at timestamptz not null, recorded_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  unique (session_id, sequence)
);

create table public.ai_practice_jobs (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, user_id uuid not null,
  kind text not null check (kind in ('run','interviewer','assistant','coach')),
  state text not null check (state in ('queued','running','completed','failed','cancelled')),
  request_id text not null, input_snapshot_id uuid not null,
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  attempt integer not null default 0 check (attempt between 0 and 3),
  reservation_sequence integer not null default 0 check (reservation_sequence >= 0),
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  claim_token uuid, worker_id text, lease_expires_at timestamptz,
  cancellation_requested boolean not null default false,
  safe_error text check (char_length(safe_error) <= 500),
  reserved_usd numeric(12,8) not null default 0 check (reserved_usd >= 0),
  actual_usd numeric(12,8) check (actual_usd >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  foreign key (input_snapshot_id, session_id, user_id) references public.ai_practice_snapshots(id, session_id, user_id),
  unique (id, session_id, user_id),
  check (state <> 'running' or (claim_token is not null and worker_id is not null and lease_expires_at is not null))
);
create index ai_practice_job_claim_queue on public.ai_practice_jobs(state, lease_expires_at, created_at);
create unique index ai_practice_one_active_kind on public.ai_practice_jobs(session_id, kind) where state in ('queued','running');

create table public.ai_practice_ai_calls (
  id uuid primary key default gen_random_uuid(), job_id uuid not null, session_id uuid not null, user_id uuid not null,
  logical_operation_id text not null unique, role text not null check (role in ('interviewer','assistant','coach')),
  provider text not null, model text not null, prompt_version text not null, schema_version text not null,
  provider_request_id text, status text not null check (status in ('reserved','completed','failed','uncertain')),
  reserved_usd numeric(12,8) not null check (reserved_usd >= 0), actual_usd numeric(12,8) check (actual_usd >= 0),
  usage jsonb, created_at timestamptz not null default now(),
  foreign key (job_id, session_id, user_id) references public.ai_practice_jobs(id, session_id, user_id) on delete cascade
);

create table public.ai_practice_reports (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, user_id uuid not null,
  generation_id uuid not null, frozen_snapshot_id uuid not null,
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  evidence_manifest jsonb not null check (jsonb_typeof(evidence_manifest) = 'object'),
  rubric_version text not null, prompt_version text not null, model text not null,
  report jsonb not null check (jsonb_typeof(report) = 'object' and octet_length(report::text) <= 256000),
  created_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade,
  foreign key (frozen_snapshot_id, session_id, user_id) references public.ai_practice_snapshots(id, session_id, user_id),
  unique (session_id, generation_id)
);

create table public.ai_practice_artifacts (
  id uuid primary key default gen_random_uuid(), session_id uuid not null, user_id uuid not null,
  kind text not null check (kind in ('workspace','audio','transcript','report','export')),
  storage_key text not null unique, sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_count bigint not null check (byte_count >= 0), retention_deadline timestamptz,
  deletion_state text not null default 'retained' check (deletion_state in ('retained','pending','deleted')),
  created_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade
);

create table public.ai_practice_requests (
  user_id uuid not null references auth.users(id) on delete cascade, request_id text not null,
  session_id uuid, operation text not null,
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  result jsonb not null, created_at timestamptz not null default now(), expires_at timestamptz not null,
  primary key (user_id, request_id),
  foreign key (session_id, user_id) references public.ai_practice_sessions(id, user_id) on delete cascade
);

-- No session FK: retain only content-free quota postings when an attempt is deleted.
-- The authenticated account FK still removes personal usage records on account deletion.
create table public.ai_practice_usage_ledger (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  opaque_session_id uuid not null, operation_id text not null,
  kind text not null check (kind in ('admission','reservation','settlement','uncertain')),
  amount_usd numeric(12,8) not null, created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (user_id, operation_id),
  check (kind = 'settlement' or amount_usd >= 0)
);
create index ai_practice_owner_usage on public.ai_practice_usage_ledger(user_id, created_at);

-- Deliberately no auth/session foreign key: cleanup inventory must survive cascades.
-- Cleanup workers only; no authenticated owner access to private storage keys.
create table public.ai_practice_deletions (
  id uuid primary key default gen_random_uuid(), opaque_owner_id text not null, opaque_session_id uuid,
  inventory jsonb not null check (jsonb_typeof(inventory) = 'array'),
  state text not null check (state in ('pending','running','completed','failed')),
  attempt integer not null default 0 check (attempt >= 0),
  lease_expires_at timestamptz, claim_token uuid,
  created_at timestamptz not null default now(), completed_at timestamptz, expires_at timestamptz not null
);

alter table public.practice_scenario_versions enable row level security;
create policy "Read published practice scenarios" on public.practice_scenario_versions for select to anon, authenticated using (published);
grant select on public.practice_scenario_versions to anon, authenticated;
revoke insert, update, delete on public.practice_scenario_versions from anon, authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array['ai_practice_sessions','ai_practice_snapshots','ai_practice_events','ai_practice_jobs','ai_practice_ai_calls','ai_practice_reports','ai_practice_artifacts','ai_practice_requests','ai_practice_usage_ledger'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('create policy "Owners read private practice records" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('grant select, insert, update, delete on public.%I to service_role', table_name);
  end loop;
end $$;
alter table public.ai_practice_deletions enable row level security;
revoke all on public.ai_practice_deletions from anon, authenticated;
grant select, insert, update, delete on public.ai_practice_deletions to service_role;
grant select, insert, update, delete on public.practice_scenario_versions to service_role;

comment on table public.ai_practice_sessions is 'Normalized design foundation. No direct client mutations; future transactional RPCs must derive auth.uid(), validate CAS/idempotency and atomically reserve quota.';
comment on table public.ai_practice_jobs is 'A qualified worker must enforce lease/fencing, cost reservation and frozen evidence semantics. Schema alone does not implement that protocol.';
comment on table public.ai_practice_deletions is 'Create inventory/tombstone and cancel jobs BEFORE deleting auth/session rows. Cleanup retries survive cascades; expire after verified cleanup and retention window.';
commit;
