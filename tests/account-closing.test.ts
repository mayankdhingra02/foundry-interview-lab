import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { digest } from '../lib/interview-practice/domain';
import type { PracticeDatabase } from '../lib/interview-practice/types';
import { MemoryPracticeStore, FilePracticeStore, type PracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { InteractionService } from '../lib/server/interactions';
import { ReviewService } from '../lib/server/review-service';
import { runRetention } from '../lib/server/retention';
import { reserveVoice } from '../lib/voice/ledger';
import { VoiceService } from '../lib/voice/provider';
import type { VoiceConfig } from '../lib/voice/config';
import { schemaCapabilitiesReady } from '../lib/server/readiness-schema';
import { readySchema } from './readiness-fixtures';

const now = new Date('2026-10-10T12:00:00.000Z');
const voice: VoiceConfig = { apiKey: 'synthetic-never-used', sttUsdPerMinute: .01, ttsUsdPerThousandChars: .01, sessionMinutes: 20, userDailyMinutes: 60, globalDailyMinutes: 600, sessionUsd: 1, userDailyUsd: 5, userMonthlyUsd: 50, globalDailyUsd: 50 };
const setup = async (store = new MemoryPracticeStore()) => {
  const owner = randomUUID(), service = new SessionService(store, getScenario, { now: () => now });
  const input = { scenarioId: 'monetary-validation', requestId: randomUUID(), voice: true };
  const created = (await service.createSession(owner, input)).session;
  return { store, service, owner, input, created };
};
function fenceWithoutErasure(database: PracticeDatabase, ownerId: string) {
  const cleanupId = randomUUID();
  database.deletions.push({ id: cleanupId, ownerId, sessionId: cleanupId, state: 'completed', objectKeys: [], createdAt: now.toISOString(), completedAt: now.toISOString() });
  database.accountClosings ??= {};
  database.accountClosings[ownerId] = { ownerId, requestId: randomUUID(), fingerprint: digest({ fixture: true }), cleanupId, createdAt: now.toISOString() };
}

describe('permanent account closing versus reusable content deletion', () => {
  it('keeps the existing content-only deletion reusable but permanently blocks both old and new create keys after closing', async () => {
    const { service, store, owner, input } = await setup();
    await service.deleteAccount(owner, { requestId: randomUUID() });
    await expect(service.createSession(owner, { ...input, requestId: randomUUID() })).resolves.toHaveProperty('session');
    const result = await service.closeAccount(owner, { requestId: randomUUID() });
    expect(result).toMatchObject({ closed: true, scope: 'permanent-account-closing', cleanupState: 'completed' });
    const before = await store.read();
    for (const requestId of [input.requestId, randomUUID()]) await expect(service.createSession(owner, { ...input, requestId })).rejects.toMatchObject({ code: 'account_closing', status: 409 });
    await expect(service.deleteAccount(owner, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'account_closing' });
    expect(await store.read()).toEqual(before);
    await expect(service.createSession(randomUUID(), { ...input, requestId: randomUUID() })).resolves.toHaveProperty('session');
  });

  it('retries permanent close without a new cache, inventory, debit or Auth dependency', async () => {
    const { service, store, owner } = await setup();
    const input = { requestId: randomUUID() }, first = await service.closeAccount(owner, input), before = await store.read();
    const authDelete = vi.fn().mockRejectedValue(new Error('synthetic Auth failure'));
    await expect(authDelete()).rejects.toThrow('synthetic Auth failure');
    const restarted = new SessionService(store, getScenario);
    expect(await restarted.closeAccount(owner, input)).toEqual(first);
    expect(await restarted.closeAccount(owner, { requestId: randomUUID() })).toEqual(first);
    expect(await store.read()).toEqual(before);
    expect(Object.values(before.requests).filter(item => item.ownerId === owner)).toHaveLength(0);
    await expect(restarted.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).rejects.toMatchObject({ code: 'account_closing' });
  });

  it('does not reuse a prior ordinary mutation key for a new permanent-close intent', async () => {
    const { service, store, owner, input } = await setup(); const before = await store.read();
    await expect(service.closeAccount(owner, { requestId: input.requestId })).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.read()).toEqual(before);
  });

  it('canonicalizes a verified UUID before erasing or fencing the existing owner', async () => {
    const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', store = new MemoryPracticeStore(), service = new SessionService(store, getScenario);
    const input = { scenarioId: 'monetary-validation', requestId: randomUUID() };
    await service.createSession(owner, input);
    // Legacy local state may already contain a case variant; closing erases it too.
    await service.createSession(owner.toUpperCase(), { ...input, requestId: randomUUID() });
    const result = await service.closeAccount(owner.toUpperCase(), { requestId: randomUUID() });
    const database = await store.read();
    expect(Object.keys(database.sessions)).toHaveLength(0);
    expect(Object.keys(database.requests)).toHaveLength(0);
    expect(Object.keys(database.accountClosings!)).toEqual([owner]);
    expect(database.accountClosings![owner]).toMatchObject({ ownerId: owner, cleanupId: result.cleanupId });
    expect(await service.closeAccount(owner.toUpperCase(), { requestId: randomUUID() })).toEqual(result);
    for (const alias of [owner, owner.toUpperCase()]) for (const requestId of [input.requestId, randomUUID()]) await expect(service.createSession(alias, { ...input, requestId })).rejects.toMatchObject({ code: 'account_closing' });
  });

  it('serializes creation already in admission, erases it, and denies a fresh concurrent admission', async () => {
    const store = new MemoryPracticeStore(), owner = randomUUID();
    let entered!: () => void, release!: () => void;
    const enteredAdmission = new Promise<void>(resolve => { entered = resolve; });
    const admissionGate = new Promise<void>(resolve => { release = resolve; });
    const service = new SessionService(store, getScenario, { admissionPolicy: async () => { entered(); await admissionGate; } });
    const first = service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() });
    await enteredAdmission;
    const closing = service.closeAccount(owner, { requestId: randomUUID() });
    const next = service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() });
    const denied = expect(next).rejects.toMatchObject({ code: 'account_closing' });
    release(); await first; await closing; await denied;
    const database = await store.read(); expect(Object.keys(database.sessions)).toHaveLength(0);
    expect(database.ledger.filter(item => item.kind === 'admission')).toHaveLength(1);
    expect(database.accountClosings?.[owner]).toBeDefined();
  });

  it('rolls back the fence and all erasure when inventory capture fails', async () => {
    const { service, store, owner, created } = await setup();
    const before = await store.read();
    Object.assign(store, { captureOwnerObjectKeys: async () => { throw new Error('synthetic inventory unavailable'); } });
    await expect(service.closeAccount(owner, { requestId: randomUUID() })).rejects.toThrow('synthetic inventory unavailable');
    expect(await store.read()).toEqual(before); expect((await service.getSession(owner, created.id)).id).toBe(created.id);
  });

  it('commits a private pending object inventory with the fence without claiming object cleanup', async () => {
    const { service, store, owner } = await setup();
    Object.assign(store, { captureOwnerObjectKeys: async () => ['synthetic/private-object'] });
    const result = await service.closeAccount(owner, { requestId: randomUUID() });
    expect(result.cleanupState).toBe('pending'); expect(JSON.stringify(result)).not.toContain('private-object');
    const database = await store.read();
    expect(database.deletions.find(item => item.id === result.cleanupId)).toMatchObject({ ownerId: owner, state: 'pending', objectKeys: ['synthetic/private-object'] });
    expect(database.accountClosings?.[owner].cleanupId).toBe(result.cleanupId);
    // Simulate only a trusted cleaner's acknowledged metadata update. No object
    // operation is performed or qualified by this fixture.
    await store.transaction(db => { const cleanup = db.deletions.find(item => item.id === result.cleanupId)!; cleanup.objectKeys = []; cleanup.state = 'completed'; cleanup.completedAt = now.toISOString(); });
    await runRetention(store, { apply: true, now: new Date('2027-10-10T12:00:00Z') });
    const retained = await store.read();
    expect(retained.deletions.find(item => item.id === result.cleanupId)).toMatchObject({ state: 'completed', objectKeys: [] });
    expect(retained.accountClosings?.[owner].cleanupId).toBe(result.cleanupId);
    expect(JSON.stringify(retained)).not.toContain('synthetic/private-object');
  });

  it('blocks cached interactions, voice admission and support mutations even with a synthetic retained session', async () => {
    const { service, store, owner, created } = await setup();
    const interaction = new InteractionService(store), control = { requestId: randomUUID(), expectedRevision: created.revision, action: 'working' as const };
    await interaction.interact(owner, created.id, control);
    const review = new ReviewService(store, getScenario, { adminUserIds: [owner] });
    const support = await review.createCase(owner, created.id, { requestId: randomUUID(), category: 'technical', message: 'Synthetic support.', inspectionConsent: true, supportActionsConsent: true });
    await store.transaction(database => fenceWithoutErasure(database, owner));
    const before = await store.read();
    await expect(interaction.interact(owner, created.id, control)).rejects.toMatchObject({ code: 'account_closing' });
    await expect(service.saveWorkspace(owner, created.id, { requestId: randomUUID(), expectedRevision: created.revision, files: created.files })).rejects.toMatchObject({ code: 'account_closing' });
    await expect(reserveVoice(store, voice, { ownerId: owner, sessionId: created.id, requestId: randomUUID(), operation: 'transcribe', fingerprint: digest('voice'), seconds: 1, characters: 0, usd: .01 })).rejects.toMatchObject({ code: 'account_closing' });
    const fetcher = vi.fn();
    await expect(new VoiceService(store, voice, fetcher).checkOwner(owner, created.id)).rejects.toMatchObject({ code: 'account_closing' }); expect(fetcher).not.toHaveBeenCalled();
    await expect(review.setConsent(owner, support.id, { requestId: randomUUID(), expectedRevision: support.revision, inspectionConsent: false, supportActionsConsent: false })).rejects.toMatchObject({ code: 'account_closing' });
    await expect(review.listCases({ id: owner, local: true })).rejects.toMatchObject({ code: 'account_closing' });
    expect(await store.read()).toEqual(before);
  });

  it('never claims fenced queued work or accepts a stale running claim', async () => {
    const { service, store, owner, created } = await setup();
    const run = await service.requestRun(owner, created.id, { requestId: randomUUID(), expectedRevision: created.revision });
    const claim = await service.claimJob('synthetic-worker'); expect(claim?.job.id).toBe(run.job?.id);
    await store.transaction(database => fenceWithoutErasure(database, owner));
    const before = await store.read();
    expect(await service.heartbeatJob(claim!)).toBe(false);
    expect(await service.completeJob(claim!, { kind: 'run', run: { status: 'infrastructure_error', command: 'not executed', stdout: '', stderr: '', exitCode: null, tests: [], durationMs: 0 } })).toBe(false);
    expect(await service.failJob(claim!, 'synthetic late result')).toBe(false);
    expect(await store.read()).toEqual(before);
    const second = await setup();
    await second.service.requestRun(second.owner, second.created.id, { requestId: randomUUID(), expectedRevision: second.created.revision });
    await second.store.transaction(database => fenceWithoutErasure(database, second.owner));
    expect(await second.service.claimJob('synthetic-worker')).toBeNull();
  });

  it('does not let ordinary store writes or retention clear the fence or its cleanup anchor', async () => {
    const { service, store, owner } = await setup();
    const closed = await service.closeAccount(owner, { requestId: randomUUID() });
    const before = await store.read();
    await expect(store.transaction(database => { delete database.accountClosings![owner]; })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.transaction(database => { database.accountClosings![owner].requestId = randomUUID(); })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(store.transaction(database => { database.deletions = database.deletions.filter(item => item.id !== closed.cleanupId); })).rejects.toMatchObject({ code: 'unavailable' });
    expect(await store.read()).toEqual(before);
    await runRetention(store, { apply: true, now: new Date('2027-10-10T12:00:00Z') });
    expect((await store.read()).deletions.some(item => item.id === closed.cleanupId)).toBe(true);
    expect((await store.read()).accountClosings?.[owner]).toEqual(before.accountClosings?.[owner]);
  });

  it('persists a content-free fence across file restart, and rejects a corrupt fence instead of reopening', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-closing-unit-'));
    try {
      const owner = randomUUID(), store = new FilePracticeStore(directory), service = new SessionService(store, getScenario);
      const session = (await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
      await service.saveWorkspace(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, files: { ...session.files, 'quote.py': '# PRIVATE-CLOSING-CONTENT' } });
      const closed = await service.closeAccount(owner, { requestId: randomUUID() });
      const restarted = new SessionService(new FilePracticeStore(directory), getScenario);
      expect(await restarted.closeAccount(owner, { requestId: randomUUID() })).toEqual(closed);
      await expect(restarted.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).rejects.toMatchObject({ code: 'account_closing' });
      expect(await readFile(store.file, 'utf8')).not.toContain('PRIVATE-CLOSING-CONTENT');
      const corrupt = JSON.parse(await readFile(store.file, 'utf8')); corrupt.accountClosings[owner].ownerId = randomUUID();
      await writeFile(store.file, JSON.stringify(corrupt));
      await expect(restarted.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('requires an explicit migration capability for permanent close but leaves legacy content deletion available', async () => {
    const memory = new MemoryPracticeStore(), store: PracticeStore = { read: () => memory.read(), transaction: callback => memory.transaction(callback) };
    const service = new SessionService(store, getScenario), owner = randomUUID();
    await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() });
    const before = await store.read();
    await expect(service.closeAccount(owner, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'unavailable' }); expect(await store.read()).toEqual(before);
    await expect(service.deleteAccount(owner, { requestId: randomUUID() })).resolves.toEqual({ deleted: true });
  });

  it('requires the private table and live guard triggers when closing readiness is requested or present', () => {
    const complete = readySchema(); expect(schemaCapabilitiesReady(complete, { accountClosing: true })).toBe(true);
    const legacy = complete.filter(item => item.name !== 'ai_practice_account_closings');
    expect(schemaCapabilitiesReady(legacy)).toBe(true); expect(schemaCapabilitiesReady(legacy, { accountClosing: true })).toBe(false);
    for (const table of ['ai_practice_account_closings', 'ai_practice_sessions', 'ai_practice_jobs', 'ai_practice_snapshots', 'ai_practice_artifacts']) {
      const broken = structuredClone(complete), row = broken.find(item => item.name === table)!;
      row.triggers = row.triggers.filter(trigger => !trigger.name.includes('account_')); expect(schemaCapabilitiesReady(broken)).toBe(false);
    }
    const exposed = structuredClone(complete); exposed.find(item => item.name === 'ai_practice_account_closings')!.authenticatedSelect = true;
    expect(schemaCapabilitiesReady(exposed)).toBe(false);
  });
});
