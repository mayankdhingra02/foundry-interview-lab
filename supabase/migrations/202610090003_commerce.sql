-- Optional practice commerce. Authentication remains the shared Foundry auth.users identity.
begin;
create table public.practice_billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique check (stripe_customer_id is null or stripe_customer_id ~ '^cus_[A-Za-z0-9]+$'),
  livemode boolean not null, blocked boolean not null default false,
  creation_started_at timestamptz not null default now(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (user_id,stripe_customer_id)
);
create table public.practice_billing_subscriptions (
  stripe_subscription_id text primary key check (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  user_id uuid not null references public.practice_billing_customers(user_id) on delete cascade,
  stripe_customer_id text not null, price_id text, status text not null,
  period_start timestamptz not null, period_end timestamptz not null,
  cancel_at_period_end boolean not null, reconciled_at timestamptz not null default now(),
  unique (stripe_subscription_id, user_id),
  foreign key (user_id,stripe_customer_id) references public.practice_billing_customers(user_id,stripe_customer_id) on delete cascade
);
create index practice_billing_owner_subscription on public.practice_billing_subscriptions(user_id, status);
create table public.practice_billing_grants (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.practice_billing_customers(user_id) on delete cascade,
  stripe_subscription_id text not null, stripe_invoice_id text not null unique,
  price_id text not null, period_start timestamptz not null, period_end timestamptz not null,
  session_allowance integer not null check (session_allowance between 1 and 500), revoked boolean not null default false,
  created_at timestamptz not null default now(),
  foreign key (stripe_subscription_id, user_id) references public.practice_billing_subscriptions(stripe_subscription_id, user_id) on delete cascade,
  unique (stripe_subscription_id, period_start, period_end), check (period_end > period_start)
);
-- No session FK: deleting Lab content must not replenish paid or free financial consumption.
create table public.practice_billing_consumptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  opaque_session_id uuid not null, request_id text not null, period_key text not null,
  source text not null check (source in ('paid','free')), period_start timestamptz not null, period_end timestamptz not null,
  consumed_at timestamptz not null default now(), retention_deadline timestamptz not null,
  unique (user_id, opaque_session_id), unique (user_id, request_id),
  check (period_end > period_start), check (length(period_key) between 1 and 160)
);
create index practice_billing_consumption_period on public.practice_billing_consumptions(user_id, period_key);
create table public.practice_billing_actions (
  user_id uuid not null references auth.users(id) on delete cascade, request_id text not null,
  operation text not null check (operation in ('checkout','portal')), fingerprint text not null,
  state text not null check (state in ('pending','completed')), result jsonb,
  created_at timestamptz not null default now(), expires_at timestamptz,
  primary key (user_id, request_id),
  check (result is null or (jsonb_typeof(result) = 'object' and octet_length(result::text) <= 8000))
);
-- Minimal verified event inbox, never the raw event/customer/payment payload.
create table public.practice_billing_webhook_events (
  event_id text primary key check (event_id ~ '^evt_[A-Za-z0-9]+$'), event_type text not null,
  object_id text not null, fingerprint text not null, livemode boolean not null,
  event_created_at timestamptz not null, received_at timestamptz not null default now(), next_attempt_at timestamptz not null default now(),
  state text not null default 'pending' check (state in ('pending','processing','completed','ignored','failed')),
  attempt integer not null default 0 check (attempt between 0 and 5), claim_token uuid, lease_expires_at timestamptz,
  completed_at timestamptz, safe_error text
);
create index practice_billing_webhook_queue on public.practice_billing_webhook_events(state, received_at);
do $$
declare target text;
begin
  foreach target in array array['practice_billing_customers','practice_billing_subscriptions','practice_billing_grants','practice_billing_consumptions','practice_billing_actions'] loop
    execute format('alter table public.%I enable row level security', target);
    execute format('revoke all on public.%I from anon, authenticated', target);
    execute format('grant select on public.%I to authenticated', target);
    execute format('grant select, insert, update, delete on public.%I to service_role', target);
    execute format('create policy "Owners read practice commerce" on public.%I for select to authenticated using ((select auth.uid()) = user_id)', target);
  end loop;
end $$;
alter table public.practice_billing_webhook_events enable row level security;
revoke all on public.practice_billing_webhook_events from anon, authenticated;
grant select, insert, update, delete on public.practice_billing_webhook_events to service_role;
comment on table public.practice_billing_consumptions is 'Content-free financial usage survives Lab content deletion. True auth account erasure cascades these rows; merchant records/provider cancellation require a separate lifecycle.';
commit;
