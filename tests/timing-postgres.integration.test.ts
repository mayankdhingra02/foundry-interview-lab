import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { PostgresPracticeStore } from '../lib/server/postgres-store';
import { SessionService } from '../lib/server/session-service';
import { withDisposablePostgres, type DisposableDatabase } from '../scripts/operations/disposable-postgres';

// Authored integration case; real SQL qualification remains pending until this
// explicit disposable-only opt-in passes. Never use a hosted DATABASE_URL.
describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== '1')('advisory timing with ordered PostgreSQL migrations', () => {
  let database: DisposableDatabase, release: (() => void) | undefined, lifetime: Promise<void> | undefined;
  beforeAll(async () => {
    let accept!: (value: DisposableDatabase) => void, reject!: (error: unknown) => void;
    const available = new Promise<DisposableDatabase>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
    lifetime = withDisposablePostgres(async value => { accept(value); await new Promise<void>(resolve => { release = resolve; }); });
    void lifetime.catch(reject); database = await available;
  }, 60_000);
  afterAll(async () => { release?.(); await lifetime; }, 60_000);
  it('persists typed setup, strict extension event and exact replay across independent store instances', async () => {
    const owner = randomUUID(); await database.admin.query('insert into auth.users(id) values ($1)', [owner]);
    const original = new SessionService(new PostgresPracticeStore(database.service), getScenario);
    const { session } = await original.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID(), targetMinutes: 60, practiceConditions: { timing: 'extra-15', participation: 'written-only' } });
    const input = { requestId: randomUUID(), expectedRevision: session.revision, additionalMinutes: 30 as const };
    const result = await original.extendTiming(owner, session.id, input);
    const reloaded = new SessionService(new PostgresPracticeStore(database.service), getScenario);
    expect(await reloaded.extendTiming(owner, session.id, { ...input, expectedRevision: 0 })).toEqual(result);
    expect((await reloaded.getSession(owner, session.id)).configuration).toMatchObject({ targetMinutes: 90, originalTargetMinutes: 60, practiceConditions: { participation: 'written-only' } });
    const rows = await database.admin.query('select event_type from public.ai_practice_events where session_id=$1 order by sequence', [session.id]);
    expect(rows.rows.map(row => row.event_type)).toEqual(['session.started', 'session.timing-extended']);
  });
});
