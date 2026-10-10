-- Content-free operational state. No session/account foreign keys or learner artifacts.
begin;
create table public.practice_worker_heartbeats (
  worker_id text primary key check (worker_id ~ '^[a-zA-Z0-9_-]{1,100}$'),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  runner_ready boolean not null default false,
  stopping boolean not null default false
);
create index practice_worker_freshness on public.practice_worker_heartbeats(last_seen_at) where not stopping;
create table public.practice_operations_state (
  key text primary key check (key = 'execution_admission'),
  blocked boolean not null default false,
  reason_code text check (reason_code in ('cleanup_unconfirmed','operator_hold')),
  updated_at timestamptz not null default now(),
  check (blocked = (reason_code is not null))
);
insert into public.practice_operations_state(key, blocked) values ('execution_admission', false);
alter table public.practice_worker_heartbeats enable row level security;
alter table public.practice_operations_state enable row level security;
revoke all on public.practice_worker_heartbeats, public.practice_operations_state from public, anon, authenticated;
grant select, insert, update, delete on public.practice_worker_heartbeats to service_role;
grant select, update on public.practice_operations_state to service_role;
comment on table public.practice_worker_heartbeats is 'Content-free worker liveness and last probed execution availability; not a provider quality or production capacity claim.';
comment on table public.practice_operations_state is 'Shared execution admission latch. Operators reconcile abandoned containers before clearing a cleanup_unconfirmed hold.';
commit;
