-- Permissioned support metadata and immutable corrections. Support permission does not authorize research.
begin;
alter table public.ai_practice_reports add constraint ai_practice_report_owner_identity unique(id,session_id,user_id);
create table public.ai_practice_review_cases (
  id uuid primary key, session_id uuid not null, user_id uuid not null, report_id uuid,
  category text not null check(category in ('feedback','technical')),
  status text not null check(status in ('open','triaged','resolved')), revision bigint not null check(revision>0),
  inspection_consent boolean not null, support_actions_consent boolean not null, consent_expires_at timestamptz,
  runtime_payload jsonb not null check(jsonb_typeof(runtime_payload)='object' and octet_length(runtime_payload::text)<=32000),
  created_at timestamptz not null, updated_at timestamptz not null,
  unique(id,session_id,user_id),
  foreign key(session_id,user_id) references public.ai_practice_sessions(id,user_id) on delete cascade,
  foreign key(report_id,session_id,user_id) references public.ai_practice_reports(id,session_id,user_id) on delete cascade
);
create unique index ai_practice_one_open_review on public.ai_practice_review_cases(session_id,category,coalesce(report_id,'00000000-0000-0000-0000-000000000000'::uuid)) where status in ('open','triaged');
create table public.ai_practice_correction_drafts (
  id uuid primary key, session_id uuid not null, user_id uuid not null, case_id uuid not null,
  source_report_id uuid not null, report_id uuid not null unique, generation_id uuid not null unique,
  evidence_digest text not null check(evidence_digest ~ '^[a-f0-9]{64}$'), evidence_watermark bigint not null check(evidence_watermark>0),
  created_by uuid not null, created_at timestamptz not null,
  runtime_payload jsonb not null check(jsonb_typeof(runtime_payload)='object' and octet_length(runtime_payload::text)<=128000),
  unique(id,session_id,user_id),
  unique(id,case_id,session_id,user_id),
  unique(id,report_id,generation_id,session_id,user_id),
  foreign key(case_id,session_id,user_id) references public.ai_practice_review_cases(id,session_id,user_id) on delete cascade,
  foreign key(source_report_id,session_id,user_id) references public.ai_practice_reports(id,session_id,user_id) on delete cascade
);
create table public.ai_practice_correction_decisions (
  id uuid primary key, session_id uuid not null, user_id uuid not null, case_id uuid not null, draft_id uuid not null unique,
  reviewer_id uuid not null, decision text not null check(decision in ('approve','reject')), created_at timestamptz not null,
  runtime_payload jsonb not null check(jsonb_typeof(runtime_payload)='object' and octet_length(runtime_payload::text)<=16000),
  foreign key(draft_id,case_id,session_id,user_id) references public.ai_practice_correction_drafts(id,case_id,session_id,user_id) on delete cascade,
  foreign key(case_id,session_id,user_id) references public.ai_practice_review_cases(id,session_id,user_id) on delete cascade
);
create table public.ai_practice_correction_publications (
  id uuid primary key, session_id uuid not null, user_id uuid not null, case_id uuid not null, draft_id uuid not null unique,
  report_id uuid not null unique, generation_id uuid not null unique, published_by uuid not null, created_at timestamptz not null,
  runtime_payload jsonb not null check(jsonb_typeof(runtime_payload)='object' and octet_length(runtime_payload::text)<=16000),
  foreign key(draft_id,case_id,session_id,user_id) references public.ai_practice_correction_drafts(id,case_id,session_id,user_id) on delete cascade,
  foreign key(draft_id,report_id,generation_id,session_id,user_id) references public.ai_practice_correction_drafts(id,report_id,generation_id,session_id,user_id) on delete cascade,
  foreign key(case_id,session_id,user_id) references public.ai_practice_review_cases(id,session_id,user_id) on delete cascade,
  foreign key(report_id,session_id,user_id) references public.ai_practice_reports(id,session_id,user_id) on delete cascade
);
create table public.ai_practice_review_audits (
  id uuid primary key, session_id uuid, user_id uuid, case_id uuid, actor_id uuid not null,
  action text not null, created_at timestamptz not null,
  runtime_payload jsonb not null check(jsonb_typeof(runtime_payload)='object' and octet_length(runtime_payload::text)<=8000),
  foreign key(session_id,user_id) references public.ai_practice_sessions(id,user_id) on delete cascade,
  foreign key(case_id,session_id,user_id) references public.ai_practice_review_cases(id,session_id,user_id) on delete cascade
);
create index ai_practice_review_queue on public.ai_practice_review_cases(status,updated_at);
create index ai_practice_review_audit_case on public.ai_practice_review_audits(case_id,created_at);
do $$
declare target text;
begin
  foreach target in array array['ai_practice_review_cases','ai_practice_correction_drafts','ai_practice_correction_decisions','ai_practice_correction_publications','ai_practice_review_audits'] loop
    execute format('alter table public.%I enable row level security',target);
    execute format('revoke all on public.%I from anon,authenticated',target);
    execute format('grant select,insert,update,delete on public.%I to service_role',target);
  end loop;
end $$;
grant select on public.ai_practice_review_cases to authenticated;
create policy "Owners read their support request" on public.ai_practice_review_cases for select to authenticated using((select auth.uid())=user_id);
-- Drafts, staff notes and audit rows require the permissioned server workflow, including owner exports.
create trigger ai_practice_correction_draft_immutable before update on public.ai_practice_correction_drafts for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_correction_decision_immutable before update on public.ai_practice_correction_decisions for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_correction_publication_immutable before update on public.ai_practice_correction_publications for each row execute function public.ai_practice_reject_immutable_update();
create trigger ai_practice_review_audit_immutable before update on public.ai_practice_review_audits for each row execute function public.ai_practice_reject_immutable_update();
comment on table public.ai_practice_correction_drafts is 'Immutable unpublished correction; separate staff approval required before appending a new report generation.';
comment on table public.ai_practice_review_audits is 'Purposeful support access only. Learner-linked rows cascade on attempt deletion; global staff author-preview metadata contains no learner content.';
commit;
