import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { disposableServiceContender } from '../scripts/operations/disposable-postgres';

describe('disposable PostgreSQL contender construction without connecting', () => {
  it.each(['create', 'claim', 'artifact'])('preserves pg-pool hidden credentials for the %s contender', async operation => {
    const password = 'a'.repeat(48); // Synthetic only; no connection is opened.
    const source = new Pool({ host: '127.0.0.1', port: 54321, user: 'postgres', password, database: 'foundry_qualification', options: '-c role=service_role', max: 12, connectionTimeoutMillis: 1000 });
    const name = `closing-${operation}-${randomUUID()}`, contender = disposableServiceContender(source, name);
    try {
      // Exercise the real driver behavior which caused the CI authentication
      // failure, while keeping credentials out of assertion failure output.
      expect(Object.getOwnPropertyDescriptor(source.options, 'password')?.enumerable).toBe(false);
      expect(Object.hasOwn({ ...source.options }, 'password')).toBe(false);
      expect(contender.options.password === password).toBe(true);
      expect(Object.keys(contender.options).includes('password')).toBe(false);
      expect(contender.options).toMatchObject({ host: '127.0.0.1', port: 54321, user: 'postgres', database: 'foundry_qualification', options: '-c role=service_role', max: 1, application_name: name, connectionTimeoutMillis: 1000 });
      expect(source.totalCount).toBe(0); expect(contender.totalCount).toBe(0);
    } finally { await Promise.all([source.end(), contender.end()]); }
  });
});
