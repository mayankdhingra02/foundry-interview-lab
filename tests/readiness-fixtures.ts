import { readFileSync, readdirSync } from 'node:fs';
import type { SchemaCapability } from '../lib/server/readiness-schema';

const directory = new URL('../supabase/migrations/', import.meta.url);
const migrations = readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => readFileSync(new URL(name, directory), 'utf8')).join('\n');
const types: Record<string, string> = { uuid: 'uuid', text: 'text', jsonb: 'jsonb', timestamptz: 'timestamptz', bigint: 'int8', integer: 'int4', boolean: 'bool' };
const privateTables = new Set(['ai_practice_jobs','ai_practice_ai_calls','ai_practice_deletions','practice_worker_heartbeats','practice_operations_state','ai_practice_correction_drafts','ai_practice_correction_decisions','ai_practice_correction_publications','ai_practice_review_audits','practice_billing_webhook_events']);

/** Catalog fixture from migration column/trigger declarations, never learner data.
 * This parser is not a SQL engine; the opt-in suite verifies actual catalogs. */
export function readySchema(): SchemaCapability[] {
  const rows = new Map<string, SchemaCapability>();
  for (const match of migrations.matchAll(/create table public\.([a-z_]+) \(([\s\S]*?)\n\);/g)) {
    const name = match[1], columns: Record<string, string> = {};
    for (const column of match[2].matchAll(/(?:^|,)\s*([a-z_][a-z0-9_]*)\s+(uuid|text|jsonb|timestamptz|bigint|integer|boolean|numeric\(\d+,\d+\))(?=[\s,]|$)/g)) columns[column[1]] = types[column[2]] ?? 'numeric';
    rows.set(name, { name, kind: 'r', rowSecurity: true, columns, checks: [], triggers: [], anonymousSelect: name === 'practice_scenario_versions', authenticatedSelect: !privateTables.has(name), clientWrites: false, serviceAccess: true, currentAccess: true, serviceBypass: true, currentBypass: true });
  }
  const runtimeMigration = readFileSync(new URL('202610090002_runtime_persistence.sql', directory), 'utf8');
  const payloadTargets = runtimeMigration.match(/foreach target in array array\[([^\]]+)\]/)![1];
  for (const target of payloadTargets.matchAll(/'([^']+)'/g)) rows.get(target[1])!.columns.runtime_payload = 'jsonb';
  for (const column of runtimeMigration.matchAll(/alter table public\.([a-z_]+) add column ([a-z_]+) (integer|bigint)/g)) rows.get(column[1])!.columns[column[2]] = types[column[3]];
  for (const trigger of migrations.matchAll(/create trigger ([a-z_]+) before update on public\.([a-z_]+) for each row execute function public\.([a-z_]+)\(\)/g)) rows.get(trigger[2])!.triggers.push({ name: trigger[1], procedure: trigger[3], schema: 'public', enabled: 'O', type: 19 });
  const eventMigration = readFileSync(new URL('202610090007_event_contract.sql', directory), 'utf8');
  const values = [...eventMigration.matchAll(/'([a-z][a-z.-]+)'/g)].map(match => `'${match[1]}'::text`);
  rows.get('ai_practice_events')!.checks.push({ name: 'ai_practice_events_event_type_check', definition: `CHECK (((schema_version = 1) AND (event_type = ANY (ARRAY[${values.join(', ')}]))))`, validated: true });
  rows.get('ai_practice_usage_ledger')!.checks.push({ name: 'ai_practice_voice_metadata', definition: 'CHECK (synthetic_catalog_fixture)', validated: true });
  return [...rows.values()];
}
