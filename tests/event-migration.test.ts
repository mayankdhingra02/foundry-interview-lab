import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { practiceEventSchema } from '../lib/interview-practice/events';
describe('strict SQL/application event vocabulary parity', () => {
  it('lists exactly the supported v1 event types in the additive SQL constraint', async () => {
    const directory = new URL('../supabase/migrations/', import.meta.url);
    const migrations = await Promise.all((await readdir(directory)).filter(name => name.endsWith('.sql')).sort().map(name => readFile(new URL(name, directory), 'utf8')));
    const migration = migrations.filter(sql => /add constraint ai_practice_events_event_type_check/i.test(sql)).at(-1)!;
    const allowlist = migration.match(/event_type in \(([\s\S]*?)\)/)?.[1]; expect(allowlist).toBeDefined();
    const sqlTypes = [...allowlist!.matchAll(/'([^']+)'/g)].map(match => match[1]);
    const applicationTypes = practiceEventSchema.options.map(schema => schema.shape.type.value);
    expect(new Set(sqlTypes).size).toBe(sqlTypes.length); expect(sqlTypes.sort()).toEqual(applicationTypes.sort());
    expect(migration).toContain('schema_version = 1'); expect(migration).not.toMatch(/drop table|disable row level security/i);
  });
  it('adds timing vocabulary in a new ordered migration while preserving the previous writer contract', async () => {
    const original = await readFile(new URL('../supabase/migrations/202610090007_event_contract.sql', import.meta.url), 'utf8');
    const extension = await readFile(new URL('../supabase/migrations/202610090009_advisory_timing.sql', import.meta.url), 'utf8');
    const vocabulary = (sql: string) => [...sql.match(/event_type in \(([\s\S]*?)\)/)![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(vocabulary(original)).not.toContain('session.timing-extended');
    expect(vocabulary(extension).sort()).toEqual([...vocabulary(original), 'session.timing-extended'].sort());
    expect(extension).not.toMatch(/drop table|disable row level security/i);
  });
});
