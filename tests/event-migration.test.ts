import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { practiceEventSchema } from '../lib/interview-practice/events';
describe('strict SQL/application event vocabulary parity', () => {
  it('lists exactly the supported v1 event types in the additive SQL constraint', async () => {
    const migration = await readFile(new URL('../supabase/migrations/202610090007_event_contract.sql', import.meta.url), 'utf8');
    const allowlist = migration.match(/event_type in \(([\s\S]*?)\)/)?.[1]; expect(allowlist).toBeDefined();
    const sqlTypes = [...allowlist!.matchAll(/'([^']+)'/g)].map(match => match[1]);
    const applicationTypes = practiceEventSchema.options.map(schema => schema.shape.type.value);
    expect(new Set(sqlTypes).size).toBe(sqlTypes.length); expect(sqlTypes.sort()).toEqual(applicationTypes.sort());
    expect(migration).toContain('schema_version = 1'); expect(migration).not.toMatch(/drop table|disable row level security/i);
  });
});
