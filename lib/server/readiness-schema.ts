import { practiceEventSchema } from '../interview-practice/events';

type Columns = Record<string, string>;
const entity = (columns: Columns): Columns => ({ ...columns, runtime_payload: 'jsonb' });
const child = (columns: Columns = {}): Columns => entity({ id: 'uuid', session_id: 'uuid', user_id: 'uuid', ...columns });
const baseline: Record<string, Columns> = {
  practice_scenario_versions: { scenario_id: 'text', version: 'text', manifest: 'jsonb', manifest_sha256: 'text', published: 'bool', created_at: 'timestamptz' },
  ai_practice_sessions: entity({ id: 'uuid', user_id: 'uuid', scenario_id: 'text', scenario_version: 'text', scenario_sha256: 'text', mode: 'text', lifecycle: 'text', stage_id: 'text', configuration: 'jsonb', prompt_exposure: 'text', revision: 'int8', code_frozen_snapshot_id: 'uuid', final_evidence_digest: 'text', final_event_watermark: 'int8', consent_version: 'text', created_at: 'timestamptz', updated_at: 'timestamptz' }),
  ai_practice_snapshots: child({ sequence: 'int8', files: 'jsonb', storage_key: 'text', content_sha256: 'text', byte_count: 'int4', created_at: 'timestamptz' }),
  ai_practice_events: child({ sequence: 'int8', schema_version: 'int4', event_type: 'text', source: 'text', request_id: 'text', payload: 'jsonb', occurred_at: 'timestamptz', recorded_at: 'timestamptz' }),
  ai_practice_jobs: child({ kind: 'text', state: 'text', request_id: 'text', input_snapshot_id: 'uuid', input_fingerprint: 'text', input: 'jsonb', attempt: 'int4', reservation_sequence: 'int4', fencing_token: 'int8', claim_token: 'uuid', worker_id: 'text', lease_expires_at: 'timestamptz', cancellation_requested: 'bool', safe_error: 'text', reserved_usd: 'numeric', actual_usd: 'numeric', created_at: 'timestamptz', updated_at: 'timestamptz', runtime_sequence: 'int4' }),
  ai_practice_ai_calls: { id: 'uuid', job_id: 'uuid', session_id: 'uuid', user_id: 'uuid', logical_operation_id: 'text', role: 'text', provider: 'text', model: 'text', prompt_version: 'text', schema_version: 'text', provider_request_id: 'text', status: 'text', reserved_usd: 'numeric', actual_usd: 'numeric', usage: 'jsonb', created_at: 'timestamptz' },
  ai_practice_reports: child({ generation_id: 'uuid', frozen_snapshot_id: 'uuid', evidence_digest: 'text', evidence_manifest: 'jsonb', rubric_version: 'text', prompt_version: 'text', model: 'text', report: 'jsonb', created_at: 'timestamptz', runtime_sequence: 'int4' }),
  ai_practice_artifacts: { id: 'uuid', session_id: 'uuid', user_id: 'uuid', kind: 'text', storage_key: 'text', sha256: 'text', byte_count: 'int8', retention_deadline: 'timestamptz', deletion_state: 'text', created_at: 'timestamptz' },
  ai_practice_requests: entity({ user_id: 'uuid', request_id: 'text', session_id: 'uuid', operation: 'text', fingerprint: 'text', result: 'jsonb', created_at: 'timestamptz', expires_at: 'timestamptz' }),
  ai_practice_usage_ledger: entity({ id: 'uuid', user_id: 'uuid', opaque_session_id: 'uuid', operation_id: 'text', kind: 'text', amount_usd: 'numeric', created_at: 'timestamptz', expires_at: 'timestamptz' }),
  ai_practice_deletions: entity({ id: 'uuid', opaque_owner_id: 'text', opaque_session_id: 'uuid', inventory: 'jsonb', state: 'text', attempt: 'int4', lease_expires_at: 'timestamptz', claim_token: 'uuid', created_at: 'timestamptz', completed_at: 'timestamptz', expires_at: 'timestamptz' }),
  ai_practice_turns: child({ role: 'text', sequence: 'int4' }),
  ai_practice_runs: child({ job_id: 'uuid', snapshot_id: 'uuid', sequence: 'int4' }),
  ai_practice_assistant_messages: child({ role: 'text', sequence: 'int4' }),
  ai_practice_edit_proposals: child({ job_id: 'uuid', snapshot_id: 'uuid', sequence: 'int4', status: 'text' }),
  ai_practice_evidence_manifests: entity({ session_id: 'uuid', user_id: 'uuid', digest: 'text', event_watermark: 'int8' }),
  practice_worker_heartbeats: { worker_id: 'text', started_at: 'timestamptz', last_seen_at: 'timestamptz', runner_ready: 'bool', stopping: 'bool' },
  practice_operations_state: { key: 'text', blocked: 'bool', reason_code: 'text', updated_at: 'timestamptz' },
};
const reviews: Record<string, Columns> = {
  ai_practice_review_cases: child({ report_id: 'uuid', category: 'text', status: 'text', revision: 'int8', inspection_consent: 'bool', support_actions_consent: 'bool', consent_expires_at: 'timestamptz', created_at: 'timestamptz', updated_at: 'timestamptz' }),
  ai_practice_correction_drafts: child({ case_id: 'uuid', source_report_id: 'uuid', report_id: 'uuid', generation_id: 'uuid', evidence_digest: 'text', evidence_watermark: 'int8', created_by: 'uuid', created_at: 'timestamptz' }),
  ai_practice_correction_decisions: child({ case_id: 'uuid', draft_id: 'uuid', reviewer_id: 'uuid', decision: 'text', created_at: 'timestamptz' }),
  ai_practice_correction_publications: child({ case_id: 'uuid', draft_id: 'uuid', report_id: 'uuid', generation_id: 'uuid', published_by: 'uuid', created_at: 'timestamptz' }),
  ai_practice_review_audits: child({ case_id: 'uuid', actor_id: 'uuid', action: 'text', created_at: 'timestamptz' }),
};
const commerce: Record<string, Columns> = {
  practice_billing_customers: { user_id: 'uuid', stripe_customer_id: 'text', livemode: 'bool', blocked: 'bool', creation_started_at: 'timestamptz', created_at: 'timestamptz', updated_at: 'timestamptz' },
  practice_billing_subscriptions: { stripe_subscription_id: 'text', user_id: 'uuid', stripe_customer_id: 'text', price_id: 'text', status: 'text', period_start: 'timestamptz', period_end: 'timestamptz', cancel_at_period_end: 'bool', reconciled_at: 'timestamptz' },
  practice_billing_grants: { id: 'uuid', user_id: 'uuid', stripe_subscription_id: 'text', stripe_invoice_id: 'text', price_id: 'text', period_start: 'timestamptz', period_end: 'timestamptz', session_allowance: 'int4', revoked: 'bool', created_at: 'timestamptz' },
  practice_billing_consumptions: { id: 'uuid', user_id: 'uuid', opaque_session_id: 'uuid', request_id: 'text', period_key: 'text', source: 'text', period_start: 'timestamptz', period_end: 'timestamptz', consumed_at: 'timestamptz', retention_deadline: 'timestamptz' },
  practice_billing_actions: { user_id: 'uuid', request_id: 'text', operation: 'text', fingerprint: 'text', state: 'text', result: 'jsonb', created_at: 'timestamptz', expires_at: 'timestamptz' },
  practice_billing_webhook_events: { event_id: 'text', event_type: 'text', object_id: 'text', fingerprint: 'text', livemode: 'bool', event_created_at: 'timestamptz', received_at: 'timestamptz', next_attempt_at: 'timestamptz', state: 'text', attempt: 'int4', claim_token: 'uuid', lease_expires_at: 'timestamptz', completed_at: 'timestamptz', safe_error: 'text' },
};
export type ReadinessFeatures = { reviews?: boolean; voice?: boolean; billing?: boolean };
export type SchemaCapability = {
  name: string; kind: string; rowSecurity: boolean; columns: Columns;
  checks: { name: string; definition: string; validated: boolean }[];
  triggers: { name: string; procedure: string; schema: string; enabled: string; type: number }[];
  anonymousSelect: boolean; authenticatedSelect: boolean; clientWrites: boolean;
  serviceAccess: boolean; currentAccess: boolean; serviceBypass: boolean; currentBypass: boolean;
};
const serverPrivate = new Set(['ai_practice_jobs', 'ai_practice_ai_calls', 'ai_practice_deletions', 'practice_worker_heartbeats', 'practice_operations_state', 'ai_practice_correction_drafts', 'ai_practice_correction_decisions', 'ai_practice_correction_publications', 'ai_practice_review_audits', 'practice_billing_webhook_events']);
const immutable: Record<string, string> = {
  ai_practice_snapshots: 'ai_practice_snapshot_immutable', ai_practice_events: 'ai_practice_event_immutable', ai_practice_reports: 'ai_practice_report_immutable', ai_practice_evidence_manifests: 'ai_practice_manifest_immutable', ai_practice_turns: 'ai_practice_turn_immutable', ai_practice_runs: 'ai_practice_run_immutable',
  ai_practice_correction_drafts: 'ai_practice_correction_draft_immutable', ai_practice_correction_decisions: 'ai_practice_correction_decision_immutable', ai_practice_correction_publications: 'ai_practice_correction_publication_immutable', ai_practice_review_audits: 'ai_practice_review_audit_immutable',
};
export const readinessTableNames = [...Object.keys(baseline), ...Object.keys(reviews), ...Object.keys(commerce)];

// Only catalogs are read. Role privilege functions include PUBLIC/inherited and
// column-only grants, so revoking the table SELECT alone cannot hide an exposure.
export const readinessSchemaQuery = `select c.relname as name,c.relkind as kind,c.relrowsecurity as "rowSecurity",
  (select coalesce(jsonb_object_agg(a.attname,t.typname),'{}'::jsonb) from pg_catalog.pg_attribute a join pg_catalog.pg_type t on t.oid=a.atttypid where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
  (select coalesce(jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_catalog.pg_get_constraintdef(x.oid),'validated',x.convalidated)),'[]'::jsonb) from pg_catalog.pg_constraint x where x.conrelid=c.oid and x.contype='c') as checks,
  (select coalesce(jsonb_agg(jsonb_build_object('name',g.tgname,'procedure',p.proname,'schema',n.nspname,'enabled',g.tgenabled,'type',g.tgtype)),'[]'::jsonb) from pg_catalog.pg_trigger g join pg_catalog.pg_proc p on p.oid=g.tgfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace where g.tgrelid=c.oid and not g.tgisinternal) as triggers,
  pg_catalog.has_any_column_privilege('anon',c.oid,'SELECT') as "anonymousSelect",
  pg_catalog.has_any_column_privilege('authenticated',c.oid,'SELECT') as "authenticatedSelect",
  (pg_catalog.has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or pg_catalog.has_any_column_privilege('anon',c.oid,'INSERT,UPDATE,REFERENCES') or pg_catalog.has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or pg_catalog.has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE,REFERENCES')) as "clientWrites",
  (pg_catalog.has_table_privilege('service_role',c.oid,'SELECT') and pg_catalog.has_table_privilege('service_role',c.oid,'UPDATE') and (c.relname='practice_operations_state' or (pg_catalog.has_table_privilege('service_role',c.oid,'INSERT') and pg_catalog.has_table_privilege('service_role',c.oid,'DELETE')))) as "serviceAccess",
  (pg_catalog.has_table_privilege(c.oid,'SELECT') and pg_catalog.has_table_privilege(c.oid,'UPDATE') and (c.relname='practice_operations_state' or (pg_catalog.has_table_privilege(c.oid,'INSERT') and pg_catalog.has_table_privilege(c.oid,'DELETE')))) as "currentAccess",
  (select r.rolbypassrls or r.rolsuper from pg_catalog.pg_roles r where r.rolname='service_role') as "serviceBypass",
  (select r.rolbypassrls or r.rolsuper from pg_catalog.pg_roles r where r.rolname=current_user) as "currentBypass"
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[])`;

function eventContract(definition: string): string {
  const normalized = definition.replace(/\s+|[()]/g, '').replace(/::text/g, '');
  return normalized.replace(/ARRAY\[([^\]]*)\]/, (_array, values: string) => `ARRAY[${values.split(',').sort().join(',')}]`);
}
const expectedEventContract = eventContract(`CHECK (schema_version = 1 AND event_type = ANY (ARRAY[${practiceEventSchema.options.map(option => `'${option.shape.type.value}'`).join(',')}]))`);

/** Capability check, not a claim of full migration equivalence or hosted RLS qualification. */
export function schemaCapabilitiesReady(rows: SchemaCapability[], features: ReadinessFeatures = {}): boolean {
  const byName = new Map(rows.map(row => [row.name, row]));
  if (byName.size !== rows.length) return false;
  const required = { ...baseline };
  // A completely absent optional feature remains compatible with the baseline
  // adapter. A configured feature or a partially applied schema must be complete.
  if (features.reviews || Object.keys(reviews).some(name => byName.has(name))) Object.assign(required, reviews);
  if (features.billing || Object.keys(commerce).some(name => byName.has(name))) Object.assign(required, commerce);
  for (const [name, columns] of Object.entries(required)) {
    const row = byName.get(name);
    if (!row || row.kind !== 'r' || row.rowSecurity !== true || row.clientWrites !== false || row.serviceAccess !== true || row.currentAccess !== true || row.serviceBypass !== true || row.currentBypass !== true || Object.entries(columns).some(([column, type]) => row.columns?.[column] !== type)) return false;
    if ((name !== 'practice_scenario_versions' && row.anonymousSelect !== false) || (serverPrivate.has(name) && row.authenticatedSelect !== false)) return false;
    const trigger = immutable[name];
    if (trigger && !row.triggers?.some(item => item.name === trigger && item.schema === 'public' && item.procedure === 'ai_practice_reject_immutable_update' && ['O', 'A'].includes(item.enabled) && item.type === 19)) return false;
  }
  const eventCheck = byName.get('ai_practice_events')?.checks?.find(check => check.name === 'ai_practice_events_event_type_check');
  if (!eventCheck?.validated || eventContract(eventCheck.definition) !== expectedEventContract) return false;
  if (features.voice && !byName.get('ai_practice_usage_ledger')?.checks?.some(check => check.name === 'ai_practice_voice_metadata' && check.validated)) return false;
  return true;
}
