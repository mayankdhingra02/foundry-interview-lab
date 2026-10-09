import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import { assertRequestNotErased, rememberErasedRequests } from '../lib/server/deleted-requests';
import { emptyDatabase, FilePracticeStore, MemoryPracticeStore, type PracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { runRetention } from '../lib/server/retention';

async function erasure(store: PracticeStore, account = false) {
  const service = new SessionService(store, getScenario);
  const input = { scenarioId: 'monetary-validation', requestId: randomUUID() };
  const created = (await service.createSession('owner-a', input)).session;
  const save = { requestId: randomUUID(), expectedRevision: created.revision, files: { ...created.files, 'quote.py': '# PRIVATE-ERASED-CODE' } };
  await service.saveWorkspace('owner-a', created.id, save);
  if (account) await service.deleteAccount('owner-a', { requestId: randomUUID() });
  else await service.deleteSession('owner-a', created.id, { requestId: randomUUID() });
  return { service, input, id: created.id, save };
}

describe('content-free erased request replay protection', () => {
  for (const account of [false, true]) it(`does not recreate or debit an erased ${account ? 'account' : 'attempt'} after a lost creation response`, async () => {
    const store = new MemoryPracticeStore(), { input, id, save } = await erasure(store, account);
    const restarted = new SessionService(store, getScenario), before = await store.read();
    await expect(restarted.createSession('owner-a', input)).rejects.toMatchObject({ code: 'request_deleted', status: 410 });
    await expect(restarted.saveWorkspace('owner-a', id, save)).rejects.toMatchObject({ code: 'request_deleted', status: 410 });
    expect(await store.read()).toEqual(before);
    expect(before.sessions).toEqual({}); expect(JSON.stringify(before)).not.toContain('PRIVATE-ERASED-CODE');
    expect(before.ledger.filter(row => row.kind === 'admission')).toHaveLength(1);
    expect(before.deletions.flatMap(row => row.erasedRequests ?? []).map(row => row.requestId)).toContain(input.requestId);
    const fresh = await restarted.createSession('owner-a', { ...input, requestId: randomUUID() });
    expect(fresh.session.id).not.toBe(id);
  });
  it('preserves conflicting-key rejection and scopes markers to their verified owner', async () => {
    const store = new MemoryPracticeStore(), { service, input } = await erasure(store);
    await expect(service.createSession('owner-a', { ...input, scenarioId: 'event-rollup' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.createSession('owner-b', input)).resolves.toHaveProperty('session');
  });
  it('does not replay an older account-delete key against newly created attempts', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const firstDelete = { requestId: randomUUID() };
    await service.createSession('owner-a', { scenarioId: 'monetary-validation', requestId: randomUUID() });
    await service.deleteAccount('owner-a', firstDelete);
    await service.createSession('owner-a', { scenarioId: 'monetary-validation', requestId: randomUUID() });
    await service.deleteAccount('owner-a', { requestId: randomUUID() });
    const fresh = (await service.createSession('owner-a', { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
    await expect(service.deleteAccount('owner-a', firstDelete)).rejects.toMatchObject({ code: 'request_deleted' });
    expect((await service.getSession('owner-a', fresh.id)).id).toBe(fresh.id);
  });
  it('bounds fresh-key no-op deletion acknowledgments without creating tombstones or blocking actual erasure', async () => {
    let clock = new Date('2026-10-09T00:00:00.000Z');
    const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario, { now: () => clock });
    let stopped = false;
    for (let index = 0; index < 55; index++) {
      try { await service.deleteAccount('owner-a', { requestId: randomUUID() }); }
      catch (error) { expect(error).toMatchObject({ code: 'quota' }); stopped = true; break; }
    }
    expect(stopped).toBe(true); const bounded = await store.read();
    expect(Object.keys(bounded.requests).length).toBeLessThanOrEqual(50); expect(bounded.deletions).toHaveLength(0);
    clock = new Date(clock.getTime() + 86_400_001);
    await service.createSession('owner-a', { scenarioId: 'monetary-validation', requestId: randomUUID() });
    await expect(service.deleteAccount('owner-a', { requestId: randomUUID() })).resolves.toEqual({ deleted: true });
    expect(await service.listSessions('owner-a')).toEqual([]);
  });
  it('persists markers across file-adapter restart while erasing copied content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-deleted-requests-'));
    try {
      const { input } = await erasure(new FilePracticeStore(directory));
      const restarted = new SessionService(new FilePracticeStore(directory), getScenario);
      await expect(restarted.createSession('owner-a', input)).rejects.toMatchObject({ code: 'request_deleted' });
      expect(JSON.stringify(await restarted.store.read())).not.toContain('PRIVATE-ERASED-CODE');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('bounds marker rows and stores only keys/hashes, with no response copies', () => {
    const db = emptyDatabase();
    const requests = Array.from({ length: 205 }, () => ({ requestId: randomUUID(), fingerprint: digest('synthetic'), result: 'PRIVATE-RESPONSE' }));
    rememberErasedRequests(db, 'owner-a', randomUUID(), requests, new Date().toISOString());
    expect(db.deletions.map(row => row.erasedRequests?.length)).toEqual([100, 100, 5]);
    expect(JSON.stringify(db)).not.toContain('PRIVATE-RESPONSE');
    expect(Object.keys(db.deletions[0].erasedRequests![0]).sort()).toEqual(['fingerprint', 'requestId']);
    expect(() => assertRequestNotErased(db, 'owner-a', requests[204].requestId, requests[204].fingerprint)).toThrowError(expect.objectContaining({ code: 'request_deleted' }));
  });
  it('fails closed on corrupt own markers without returning their data', () => {
    const db = emptyDatabase();
    rememberErasedRequests(db, 'owner-a', randomUUID(), [{ requestId: randomUUID(), fingerprint: digest('fixture') }], new Date().toISOString());
    db.deletions[0].erasedRequests![0].fingerprint = 'PRIVATE-BAD-MARKER';
    expect(() => assertRequestNotErased(db, 'owner-a', randomUUID(), digest('fixture'))).toThrowError(expect.objectContaining({ code: 'unavailable', message: 'Erased request identities could not be verified.' }));
    expect(() => assertRequestNotErased(db, 'owner-b', randomUUID(), digest('fixture'))).not.toThrow();
  });
  it('retains the bounded replay guarantee until explicit retention removes completed markers', async () => {
    let clock = new Date('2026-10-09T00:00:00.000Z');
    const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario, { now: () => clock });
    const input = { scenarioId: 'monetary-validation', requestId: randomUUID() };
    const session = (await service.createSession('owner-a', input)).session;
    await service.deleteSession('owner-a', session.id, { requestId: randomUUID() });
    clock = new Date('2026-11-07T23:59:59.999Z');
    await runRetention(store, { apply: true, now: clock });
    await expect(service.createSession('owner-a', input)).rejects.toMatchObject({ code: 'request_deleted' });
    clock = new Date('2026-11-09T00:00:00.000Z');
    await runRetention(store, { apply: true, now: clock });
    await expect(service.createSession('owner-a', input)).resolves.toHaveProperty('session');
  });
});
