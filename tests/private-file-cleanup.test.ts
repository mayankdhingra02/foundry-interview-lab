import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../lib/interview-practice/domain';
import { ownsPrivateInventoryKey, ownsPrivateObjectKey, PRIVATE_CLEANUP_POLICY, validateDeletionCleanup } from '../lib/interview-practice/private-cleanup';
import type { DeletionRecord } from '../lib/interview-practice/types';
import { runPrivateFileCleanup } from '../lib/server/private-file-cleanup';
import type { PrivateObjectStore } from '../lib/server/private-object-store';
import { FilePracticeStore, MemoryPracticeStore, type PracticeStore } from '../lib/server/store';

const base = new Date('2026-10-11T12:00:00.000Z');
const targetDigest = digest({ fixture: 'no-external-storage' });
const temporary: string[] = []; afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
function key(owner: string, session = randomUUID()) { return `owners/${owner}/sessions/${session}/artifacts/${randomUUID()}`; }
async function setup(store: PracticeStore = new MemoryPracticeStore(), objectCount = 2) {
  const owner = randomUUID(), id = randomUUID(), keys = Array.from({ length: objectCount }, () => key(owner));
  await store.transaction(database => {
    database.deletions.push({ id, ownerId: owner, sessionId: id, createdAt: base.toISOString(), state: 'pending', objectKeys: keys });
    database.accountClosings = { [owner]: { ownerId: owner, cleanupId: id, requestId: randomUUID(), fingerprint: digest('synthetic closing'), createdAt: base.toISOString() } };
  });
  const objects: PrivateObjectStore = { targetDigest, verifyPrivateBucket: vi.fn(async () => true), remove: vi.fn(async () => undefined), absence: vi.fn(async () => 'absent' as const) };
  return { store, owner, id, keys, objects };
}
const apply = { apply: true, now: () => base };

describe('fixed registered private-object policy', () => {
  it('binds exact owner/session/artifact UUID paths and preserves unknown legacy or foreign keys', () => {
    const owner = randomUUID(), session = randomUUID(), id = randomUUID(), valid = key(owner, session);
    expect(ownsPrivateObjectKey(owner, valid)).toBe(true);
    for (const candidate of [key(randomUUID()), valid.toUpperCase(), `${valid}/child`, valid.replace('/artifacts/', '/../'), `https://example.test/${valid}`, `interview-lab-private/${valid}`, valid.replace('/sessions/', '/sessions/%2e%2e/')]) expect(ownsPrivateObjectKey(owner, candidate)).toBe(false);
    const record: DeletionRecord = { id, ownerId: owner, sessionId: session, state: 'pending', objectKeys: [valid], createdAt: base.toISOString() };
    expect(ownsPrivateInventoryKey(record, valid, randomUUID())).toBe(true);
    expect(ownsPrivateInventoryKey(record, key(owner), randomUUID())).toBe(false);
    expect(ownsPrivateInventoryKey(record, key(owner), id)).toBe(true);
  });
  it('accepts legacy metadata omission but rejects incomplete leases, unknown fields and nonempty completion', () => {
    const record: DeletionRecord = { id: randomUUID(), ownerId: randomUUID(), sessionId: randomUUID(), state: 'pending', objectKeys: ['legacy/key'], createdAt: base.toISOString() };
    expect(() => validateDeletionCleanup(record)).not.toThrow();
    const cleanup = { version: 1 as const, targetDigest, attempt: 1, failureCount: 0, claimToken: null, leaseExpiresAt: null, nextAttemptAt: null, lastError: null };
    expect(() => validateDeletionCleanup({ ...record, cleanup })).not.toThrow();
    expect(() => validateDeletionCleanup({ ...record, cleanup: { ...cleanup, claimToken: randomUUID() } })).toThrow();
    expect(() => validateDeletionCleanup({ ...record, cleanup: { ...cleanup, unknown: true } as typeof cleanup })).toThrow();
    expect(() => validateDeletionCleanup({ ...record, state: 'completed', completedAt: base.toISOString(), cleanup })).toThrow();
  });
});

describe('manual leased private-file cleanup', () => {
  it('defaults to read-only counts without credentials, transactions or external storage activity', async () => {
    const fixture = await setup(), before = await fixture.store.read(), transaction = vi.spyOn(fixture.store, 'transaction');
    expect(await runPrivateFileCleanup(fixture.store)).toMatchObject({ mode: 'dry_run', eligibleRecords: 1, attemptedRecords: 0 });
    expect(transaction).not.toHaveBeenCalled(); expect(await fixture.store.read()).toEqual(before);
    expect(fixture.objects.verifyPrivateBucket).not.toHaveBeenCalled();
  });
  it('requires an exact verified private bucket before changing any inventory or claiming work', async () => {
    const fixture = await setup(), before = await fixture.store.read(); vi.mocked(fixture.objects.verifyPrivateBucket).mockResolvedValue(false);
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ status: 'bucket_unverified', attemptedRecords: 0 });
    expect(fixture.objects.remove).not.toHaveBeenCalled(); expect(await fixture.store.read()).toEqual(before);
  });
  it('requires live closing readiness inside a transaction before any Storage request', async () => {
    const fixture = await setup(), before = await fixture.store.read();
    const guard = vi.fn(async () => { throw new Error('unavailable'); }); Object.assign(fixture.store, { assertPrivateCleanupReady: guard });
    await expect(runPrivateFileCleanup(fixture.store, fixture.objects, apply)).rejects.toThrow('unavailable');
    expect(guard).toHaveBeenCalledTimes(1); expect(fixture.objects.verifyPrivateBucket).not.toHaveBeenCalled(); expect(fixture.objects.remove).not.toHaveBeenCalled();
    expect(await fixture.store.read()).toEqual(before);
  });
  it('rechecks live readiness at claim and refuses changed guard state before delete', async () => {
    const fixture = await setup(), before = await fixture.store.read(); let ready = true;
    Object.assign(fixture.store, { assertPrivateCleanupReady: vi.fn(async () => { if (!ready) throw new Error('guard_disabled'); }) });
    vi.mocked(fixture.objects.verifyPrivateBucket).mockImplementation(async () => { ready = false; return true; });
    await expect(runPrivateFileCleanup(fixture.store, fixture.objects, apply)).rejects.toThrow('guard_disabled');
    expect(fixture.objects.remove).not.toHaveBeenCalled(); expect(await fixture.store.read()).toEqual(before);
  });
  it('does not acknowledge absence if guard readiness or target identity changes during external work', async () => {
    const fixture = await setup(undefined, 1); let ready = true;
    Object.assign(fixture.store, { assertPrivateCleanupReady: vi.fn(async () => { if (!ready) throw new Error('guard_disabled'); }) });
    vi.mocked(fixture.objects.absence).mockImplementationOnce(async () => { ready = false; return 'absent'; });
    await expect(runPrivateFileCleanup(fixture.store, fixture.objects, apply)).rejects.toThrow('guard_disabled');
    expect((await fixture.store.read()).deletions[0].objectKeys).toEqual(fixture.keys);
    const other = await setup(undefined, 1);
    vi.mocked(other.objects.absence).mockImplementationOnce(async () => { Object.assign(other.objects, { targetDigest: digest('changed during work') }); return 'absent'; });
    await expect(runPrivateFileCleanup(other.store, other.objects, apply)).rejects.toThrow('target_changed');
    expect((await other.store.read()).deletions[0].objectKeys).toEqual(other.keys);
  });
  it('verifies every exact object absent before completing a content-free retained anchor', async () => {
    const fixture = await setup(), before = await fixture.store.read();
    const result = await runPrivateFileCleanup(fixture.store, fixture.objects, apply);
    expect(result).toMatchObject({ verifiedAbsentObjects: 2, completedRecords: 1, failedRecords: 0 });
    const database = await fixture.store.read(), record = database.deletions[0];
    expect(record).toMatchObject({ state: 'completed', objectKeys: [], completedAt: base.toISOString(), cleanup: { attempt: 1, claimToken: null, leaseExpiresAt: null, lastError: null } });
    expect(database.accountClosings).toEqual(before.accountClosings); expect(database.ledger).toEqual(before.ledger);
    expect(JSON.stringify(result)).not.toContain(fixture.owner); expect(JSON.stringify(record)).not.toContain('/artifacts/');
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ attemptedRecords: 0, verifiedAbsentObjects: 0 });
  });
  it('cleans earlier session inventories once that owner is permanently closed, preserving wrong-session keys', async () => {
    const fixture = await setup(undefined, 1), oldSession = randomUUID(), oldId = randomUUID(), valid = key(fixture.owner, oldSession), wrongSession = key(fixture.owner);
    await fixture.store.transaction(database => database.deletions.push({ id: oldId, ownerId: fixture.owner, sessionId: oldSession, state: 'pending', objectKeys: [valid, wrongSession], createdAt: '2026-10-10T00:00:00.000Z' }));
    const result = await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, maxRecords: 2 });
    expect(result).toMatchObject({ attemptedRecords: 2, verifiedAbsentObjects: 2, unrecognizedObjects: 1 });
    expect((await fixture.store.read()).deletions.find(record => record.id === oldId)?.objectKeys).toEqual([wrongSession]);
    expect(fixture.objects.remove).toHaveBeenCalledWith(fixture.owner, valid, undefined);
    expect(fixture.objects.remove).not.toHaveBeenCalledWith(fixture.owner, wrongSession, undefined);
  });
  it('never acts on an unfenced owner or foreign/legacy keys even in a mixed registered inventory', async () => {
    const fixture = await setup(undefined, 1), foreign = key(randomUUID()), legacy = 'synthetic/old-unknown-target', unanchored = randomUUID();
    await fixture.store.transaction(database => { database.deletions[0].objectKeys.push(foreign, legacy); database.deletions.push({ id: randomUUID(), ownerId: unanchored, sessionId: randomUUID(), state: 'pending', objectKeys: [key(unanchored)], createdAt: base.toISOString() }); });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ verifiedAbsentObjects: 1, completedRecords: 0, unanchoredRecords: 1, unrecognizedObjects: 2 });
    expect((await fixture.store.read()).deletions[0].objectKeys).toEqual([foreign, legacy]); expect(fixture.objects.remove).toHaveBeenCalledTimes(1);
  });
  it('retains unknown/present objects, commits partial progress and resumes after bounded backoff', async () => {
    const fixture = await setup(undefined, 3); vi.mocked(fixture.objects.absence).mockResolvedValueOnce('absent').mockResolvedValueOnce('unknown').mockResolvedValueOnce('present');
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ verifiedAbsentObjects: 1, failedRecords: 1, completedRecords: 0 });
    const first = (await fixture.store.read()).deletions[0]; expect(first.objectKeys).toEqual(fixture.keys.slice(1)); expect(first.cleanup).toMatchObject({ attempt: 1, lastError: 'object_still_present', claimToken: null });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ deferredRecords: 1, attemptedRecords: 0 });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, now: () => new Date(base.getTime() + 5000) })).toMatchObject({ verifiedAbsentObjects: 2, completedRecords: 1 });
  });
  it('reconciles a lost delete response only when the independent exact-key probe proves absence', async () => {
    const fixture = await setup(undefined, 1); vi.mocked(fixture.objects.remove).mockRejectedValue(new Error('private diagnostic never returned'));
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ verifiedAbsentObjects: 1, completedRecords: 1 });
  });
  it('keeps external operations outside store transactions so they cannot deadlock or recreate private content', async () => {
    const fixture = await setup(undefined, 1);
    vi.mocked(fixture.objects.remove).mockImplementation(async () => { const database = await fixture.store.read(); expect(database.deletions[0].cleanup?.claimToken).toBeTruthy(); await fixture.store.transaction(() => undefined); });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ completedRecords: 1 });
  });
  it('serializes concurrent claims without duplicate object work', async () => {
    const fixture = await setup(undefined, 1); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked(fixture.objects.remove).mockImplementation(async () => { entered(); await gate; });
    const first = runPrivateFileCleanup(fixture.store, fixture.objects, apply); await inside;
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ leasedRecords: 1, attemptedRecords: 0 });
    release(); await first; expect(fixture.objects.remove).toHaveBeenCalledTimes(1);
  });
  it('rejects stale callbacks after lease replacement and leaves newer inventory intact', async () => {
    const fixture = await setup(undefined, 1);
    vi.mocked(fixture.objects.absence).mockImplementation(async () => { await fixture.store.transaction(database => { database.deletions[0].cleanup!.claimToken = randomUUID(); }); return 'absent'; });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ verifiedAbsentObjects: 0, staleResults: 1 });
    expect((await fixture.store.read()).deletions[0].objectKeys).toEqual(fixture.keys);
  });
  it('rejects expired results and reclaims only after lease expiry without clearing keys prematurely', async () => {
    const fixture = await setup(undefined, 1); let clock = base.getTime();
    vi.mocked(fixture.objects.absence).mockImplementationOnce(async () => { clock += PRIVATE_CLEANUP_POLICY.leaseMs; return 'absent'; });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, now: () => new Date(clock) })).toMatchObject({ staleResults: 1, completedRecords: 0 });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, now: () => new Date(clock) })).toMatchObject({ completedRecords: 1 });
    expect((await fixture.store.read()).deletions[0].cleanup).toMatchObject({ attempt: 2, failureCount: 1 });
  });
  it('allows more than eight successful bounded batches without exhausting failure retries', async () => {
    const fixture = await setup(undefined, 10);
    for (let index = 0; index < 10; index++) expect(await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, maxObjects: 1 })).toMatchObject({ attemptedRecords: 1, verifiedAbsentObjects: 1 });
    expect((await fixture.store.read()).deletions[0]).toMatchObject({ state: 'completed', cleanup: { attempt: 10, failureCount: 0 } });
  });
  it('holds an expired eighth failed claim without repeated Storage calls or double-counting expiry', async () => {
    const fixture = await setup(undefined, 1);
    await fixture.store.transaction(database => { database.deletions[0].cleanup = { version: 1, targetDigest, attempt: 8, failureCount: 7, claimToken: randomUUID(), leaseExpiresAt: base.toISOString(), nextAttemptAt: null, lastError: null }; });
    for (let index = 0; index < 2; index++) expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ exhaustedRecords: 1, attemptedRecords: 0 });
    expect(fixture.objects.verifyPrivateBucket).not.toHaveBeenCalled(); expect(fixture.objects.remove).not.toHaveBeenCalled();
    expect((await fixture.store.read()).deletions[0].cleanup?.failureCount).toBe(7);
  });
  it('rejects oversized or duplicate inventories and invalid batch bounds before object deletion', async () => {
    const fixture = await setup(undefined, 1);
    await fixture.store.transaction(database => { database.deletions[0].objectKeys.push(...fixture.keys); });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ malformedRecords: 1, attemptedRecords: 0 });
    expect(fixture.objects.verifyPrivateBucket).not.toHaveBeenCalled();
    for (const maxObjects of [0, 21, 1.5]) await expect(runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, maxObjects })).rejects.toThrow('options_invalid');
  });
  it('does not acknowledge changed inventory, target drift, exhausted attempts or cancellation', async () => {
    const fixture = await setup(undefined, 1), controller = new AbortController();
    vi.mocked(fixture.objects.absence).mockImplementation(async () => { controller.abort(); return 'absent'; });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, signal: controller.signal })).toMatchObject({ status: 'interrupted', verifiedAbsentObjects: 0 });
    const record = (await fixture.store.read()).deletions[0]; expect(record.objectKeys).toEqual(fixture.keys); expect(record.cleanup?.lastError).toBe('interrupted');
    expect(await runPrivateFileCleanup(fixture.store, { ...fixture.objects, targetDigest: digest('different project') }, apply)).toMatchObject({ targetMismatchRecords: 1, attemptedRecords: 0 });
    await fixture.store.transaction(database => { database.deletions[0].cleanup = { ...record.cleanup!, failureCount: 8, nextAttemptAt: null }; });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ exhaustedRecords: 1, attemptedRecords: 0 });
  });
  it('retains snapshot identity when inventory changes during the external call', async () => {
    const fixture = await setup(undefined, 1), later = key(fixture.owner);
    vi.mocked(fixture.objects.absence).mockImplementation(async () => { await fixture.store.transaction(database => { database.deletions[0].objectKeys.push(later); }); return 'absent'; });
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, apply)).toMatchObject({ staleResults: 1, verifiedAbsentObjects: 0 });
    expect((await fixture.store.read()).deletions[0].objectKeys).toEqual([...fixture.keys, later]);
  });
  it('bounds objects per batch and preserves pending progress across a file-store restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-private-cleanup-')); temporary.push(directory);
    const fixture = await setup(new FilePracticeStore(directory), 2);
    expect(await runPrivateFileCleanup(fixture.store, fixture.objects, { ...apply, maxObjects: 1 })).toMatchObject({ verifiedAbsentObjects: 1, completedRecords: 0 });
    const restarted = new FilePracticeStore(directory);
    expect((await restarted.read()).deletions[0].objectKeys).toEqual([fixture.keys[1]]);
    expect(await runPrivateFileCleanup(restarted, fixture.objects, { ...apply, now: () => new Date(base.getTime() + 5000) })).toMatchObject({ completedRecords: 1 });
  });
});
