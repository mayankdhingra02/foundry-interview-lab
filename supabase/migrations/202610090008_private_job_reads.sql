-- Worker claims, generation inputs and inference provenance are server-private.
-- Learners read redacted job DTOs through the verified-owner application API.
begin;
revoke select on public.ai_practice_jobs, public.ai_practice_ai_calls from public, anon, authenticated;
-- Existing service-role mutation grants and owner RLS constraints are unchanged.
grant select on public.ai_practice_jobs, public.ai_practice_ai_calls to service_role;
comment on table public.ai_practice_jobs is 'Server-private durable jobs. Only verified-owner application APIs expose redacted job DTOs; trusted workers enforce leases, fences and frozen evidence.';
comment on table public.ai_practice_ai_calls is 'Server-private provider provenance. No direct authenticated or anonymous SELECT access.';
commit;
