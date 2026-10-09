import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { budgetTotals } from '../lib/interview-practice/quota';
import type { DeletionRecord, LedgerEntry, PracticeDatabase, RequestRecord } from '../lib/interview-practice/types';
import { RETENTION_POLICY, runRetention } from '../lib/server/retention';
import { emptyDatabase, FilePracticeStore, MemoryPracticeStore, type PracticeStore } from '../lib/server/store';
import { finalAttempt, harness, openCase, owner } from './review-fixtures';

const now = new Date('2026-10-09T12:30:00.000Z'), DAY = 86_400_000;
const at = (days: number, milliseconds = 0) => new Date(now.getTime() - days * DAY + milliseconds).toISOString();
const old = at(90), privateText = 'PRIVATE-RETENTION-FIXTURE-CONTENT';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory() { const value = await mkdtemp(join(tmpdir(), 'foundry-retention-')); directories.push(value); return value; }
async function seeded(database = emptyDatabase()) { const store = new MemoryPracticeStore(); await store.transaction(db => Object.assign(db, structuredClone(database))); return store; }
function request(database: PracticeDatabase, result: unknown, extra: Partial<RequestRecord> = {}) {
  const record = { ownerId: owner, requestId: randomUUID(), fingerprint: 'synthetic-fingerprint', createdAt: at(30), result, ...extra };
  const key = `${record.ownerId}:${record.requestId}`; database.requests[key] = record; return key;
}
function deletion(sessionId: string = randomUUID(), extra: Partial<DeletionRecord> = {}): DeletionRecord {
  return { id: randomUUID(), ownerId: owner, sessionId, state: 'completed', objectKeys: [], createdAt: at(30), completedAt: at(30), ...extra };
}
function posting(prefix: string, kind: LedgerEntry['kind'], amountUsd: number, extra: Partial<LedgerEntry> = {}): LedgerEntry {
  const suffix = kind === 'reservation' ? 'reserve' : kind === 'settlement' ? 'settle' : kind;
  return { id: randomUUID(), ownerId: owner, sessionId: 'synthetic-deleted-session', operationId: `${prefix}:${suffix}`, kind, amountUsd, createdAt: at(62), ...extra };
}
function settled(prefix: string, extra: Partial<LedgerEntry> = {}) { return [posting(prefix, 'reservation', .08, extra), posting(prefix, 'settlement', -.06, extra)]; }
async function completed() {
  const context = harness(undefined, () => new Date(old));
  const session = await finalAttempt(context);
  const database = await context.store.read();
  database.requests = {}; database.ledger = [];
  return { context, database, session: database.sessions[session.id] };
}
const keepCounts = { requests: 0, ledger: 0, deletions: 0 };

describe('operational retention boundaries and locking', () => {
  it('uses inclusive 30-day metadata and 62-day ledger cutoffs, preserving rows one millisecond younger', async () => {
    const db = emptyDatabase();
    request(db, { deleted: true }); request(db, { deleted: true }, { createdAt: at(30, 1) });
    db.ledger = [...settled('eligible'), ...settled('younger', { createdAt: at(62, 1) })];
    db.deletions = [deletion(), deletion(undefined, { createdAt: at(30, 1) })];
    const store = await seeded(db), result = await runRetention(store, { apply: true, now });
    expect(result.removed).toEqual({ requests: 1, ledger: 2, deletions: 1 });
    expect(result.retained.not_expired).toBe(4);
    expect(result.cutoffs).toEqual({ ledger: at(62), metadata: at(30) });
  });
  it('defaults to dry-run without calling a write transaction or changing data', async () => {
    const db = emptyDatabase(); request(db, { deleted: true }); db.ledger = settled('old');
    const store = await seeded(db), transaction = vi.spyOn(store, 'transaction');
    const before = await store.read(), result = await runRetention(store, { now });
    expect(result.mode).toBe('dry-run'); expect(result.selected).toEqual({ requests: 1, ledger: 2, deletions: 0 });
    expect(result.removed).toEqual(keepCounts); expect(transaction).not.toHaveBeenCalled(); expect(await store.read()).toEqual(before);
  });
  it('does not create a missing file directory and leaves existing dry-run bytes and mtime unchanged', async () => {
    const root = await directory(), missing = join(root, 'missing'), missingStore = new FilePracticeStore(missing);
    await runRetention(missingStore, { now }); await expect(stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    const store = new FilePracticeStore(root), db = emptyDatabase(); request(db, { deleted: true });
    const bytes = JSON.stringify(db); await writeFile(store.file, bytes); const before = await stat(store.file);
    await runRetention(store, { now }); expect(await readFile(store.file, 'utf8')).toBe(bytes); expect((await stat(store.file)).mtimeMs).toBe(before.mtimeMs);
  });
  it('replans inside the transaction instead of applying a stale dry-run selection', async () => {
    const db = emptyDatabase(), key = request(db, { deleted: true });
    const store: PracticeStore = {
      read: vi.fn(async () => structuredClone(db)),
      transaction: vi.fn(async operation => { db.requests[key].createdAt = now.toISOString(); return operation(db); }),
    };
    expect((await runRetention(store, { now })).selected.requests).toBe(1);
    expect((await runRetention(store, { apply: true, now })).removed.requests).toBe(0);
    expect(store.read).toHaveBeenCalledTimes(1); expect(db.requests[key]).toBeDefined();
  });
  it('bounds the complete batch, never splits a ledger group, and becomes an idempotent no-op', async () => {
    const db = emptyDatabase(); request(db, { deleted: true }); db.ledger = settled('whole'); db.deletions = [deletion()];
    const store = await seeded(db);
    const first = await runRetention(store, { apply: true, maxRows: 2, now });
    expect(first.removed).toEqual({ requests: 1, ledger: 0, deletions: 1 }); expect(first.moreEligible).toBe(true); expect((await store.read()).ledger).toHaveLength(2);
    const second = await runRetention(store, { apply: true, maxRows: 2, now }); expect(second.removed.ledger).toBe(2);
    const third = await runRetention(store, { apply: true, maxRows: 2, now }); expect(third.removed).toEqual(keepCounts); expect(third.moreEligible).toBe(false);
  });
  it.each([0, -1, 1001, 1.5, NaN])('rejects invalid batch size %s before mutation', async maxRows => {
    const store = await seeded(); await expect(runRetention(store, { apply: true, maxRows, now })).rejects.toMatchObject({ code: 'invalid_options' }); expect(await store.read()).toEqual(emptyDatabase());
  });
  it('rejects invalid clocks and a scan beyond its safety bound without deleting anything', async () => {
    const store = await seeded(); await expect(runRetention(store, { now: new Date(NaN) })).rejects.toMatchObject({ code: 'invalid_options' });
    const db = emptyDatabase();
    db.ledger = Array.from({ length: RETENTION_POLICY.maximumScannedRows + 1 }, () => posting('oversize', 'admission', 0));
    const read = async () => db, transaction: PracticeStore['transaction'] = async operation => operation(db);
    await expect(runRetention({ read, transaction }, { apply: true, now })).rejects.toMatchObject({ code: 'scan_limit' }); expect(db.ledger).toHaveLength(100_001);
  });
});

describe('terminal cache expiry preserves canonical attempts and obligations', () => {
  it('expires a full create-response copy inferred from result.session.id while preserving every canonical child and support audit', async () => {
    const { database, session } = await completed();
    request(database, { session: { ...session, privateText } });
    database.reviews ??= { cases: {}, drafts: {}, decisions: {}, publications: {}, audits: [] };
    database.reviews.audits.push({ id: randomUUID(), actorId: owner, ownerId: owner, sessionId: session.id, action: 'fixture-audit', purpose: privateText, createdAt: old });
    const store = await seeded(database), canonical = structuredClone(database.sessions), reviews = structuredClone(database.reviews);
    const result = await runRetention(store, { apply: true, now });
    expect(result.removed.requests).toBe(1); expect((await store.read()).sessions).toEqual(canonical); expect((await store.read()).reviews).toEqual(reviews);
    expect(JSON.stringify(result)).not.toContain(privateText); expect(JSON.stringify(result)).not.toContain(session.id); expect(JSON.stringify(result)).not.toContain(owner);
  });
  it.each(['active', 'paused', 'reviewing'] as const)('keeps expired create caches for %s attempts, preventing duplicate creation after a retry', async lifecycle => {
    const { database, session } = await completed(); session.lifecycle = lifecycle; const key = request(database, { session });
    const store = await seeded(database), result = await runRetention(store, { apply: true, now });
    expect(result.retained.active_obligation).toBe(1); expect((await store.read()).requests[key]).toBeDefined();
  });
  it.each(['queued', 'running'] as const)('retains completed-attempt caches while a %s job remains', async state => {
    const { database, session } = await completed(); session.jobs[0].state = state; const key = request(database, { session });
    const store = await seeded(database); await runRetention(store, { apply: true, now }); expect((await store.read()).requests[key]).toBeDefined();
  });
  it('retains caches for an open support case without deleting support records', async () => {
    const { context, session } = await completed(); await openCase(context, session.id);
    const database = await context.store.read(); database.requests = {}; request(database, { session });
    const store = await seeded(database), result = await runRetention(store, { apply: true, now });
    expect(result.retained.active_obligation).toBeGreaterThan(0); expect((await store.read()).reviews).toEqual(database.reviews);
  });
  it('keeps ambiguous legacy links, conflicting session IDs, owner mismatch, malformed clocks and terminal sessions without a report', async () => {
    const { database, session } = await completed();
    request(database, { privateText }); request(database, { session }, { sessionId: randomUUID() });
    request(database, { session }, { ownerId: randomUUID() }); request(database, { session }, { createdAt: '2026-09-09' });
    const noReport = structuredClone(session); noReport.id = randomUUID(); noReport.events = []; noReport.reports = []; database.sessions[noReport.id] = noReport; request(database, { session: noReport });
    const store = await seeded(database), result = await runRetention(store, { apply: true, now });
    expect(result.retained.ambiguous_reference).toBe(5); expect(result.removed).toEqual(keepCounts);
  });
  it('keeps unlinked deletion acknowledgments while their owner has an active attempt', async () => {
    const { database, session } = await completed(); session.lifecycle = 'active'; request(database, { deleted: true });
    expect((await runRetention(await seeded(database), { apply: true, now })).retained.active_obligation).toBe(1);
  });
});

describe('deletion metadata retention', () => {
  it('expires verified deleted-session caches and their old completed tombstone together', async () => {
    const db = emptyDatabase(), record = deletion(); db.deletions.push(record); request(db, { session: { id: record.sessionId, files: { 'main.py': privateText } } });
    const store = await seeded(db), result = await runRetention(store, { apply: true, now });
    expect(result.removed).toEqual({ requests: 1, ledger: 0, deletions: 1 }); expect(await store.read()).toEqual(emptyDatabase());
  });
  it('retains a tombstone needed by a recent response, then expires both after the response cutoff', async () => {
    const db = emptyDatabase(), record = deletion(); db.deletions.push(record); request(db, { sessionId: record.sessionId }, { createdAt: at(30, 1) });
    const store = await seeded(db), first = await runRetention(store, { apply: true, now });
    expect(first.retained.referenced_metadata).toBe(1); expect(first.removed).toEqual(keepCounts);
    expect((await runRetention(store, { apply: true, now: new Date(now.getTime() + 1) })).removed).toEqual({ requests: 1, ledger: 0, deletions: 1 });
  });
  it('does not remove tombstones before an unselected cache when the row budget is exhausted', async () => {
    const db = emptyDatabase(), record = deletion(); db.deletions.push(record); request(db, { deleted: true }, { createdAt: old }); request(db, { sessionId: record.sessionId });
    const store = await seeded(db), first = await runRetention(store, { apply: true, maxRows: 1, now });
    expect(first.removed.requests).toBe(1); expect(first.retained.referenced_metadata).toBe(1); expect((await store.read()).deletions).toHaveLength(1);
    expect((await runRetention(store, { apply: true, maxRows: 2, now })).removed).toEqual({ requests: 1, ledger: 0, deletions: 1 });
  });
  it('preserves pending cleanup, incomplete inventories and recently completed or malformed metadata', async () => {
    const db = emptyDatabase(); db.deletions = [deletion(undefined, { state: 'pending' }), deletion(undefined, { objectKeys: ['private/object/key'] }), deletion(undefined, { completedAt: undefined }), deletion(undefined, { completedAt: at(30, 1) }), deletion(undefined, { createdAt: 'invalid' })];
    const store = await seeded(db), result = await runRetention(store, { apply: true, now });
    expect(result.retained.pending_cleanup).toBe(3); expect(result.removed.deletions).toBe(0); expect((await store.read()).deletions).toEqual(db.deletions);
  });
  it('holds duplicate tombstone IDs instead of deleting another protected copy by ID', async () => {
    const db = emptyDatabase(), record = deletion(); db.deletions = [record, { ...record, state: 'pending' }];
    expect((await runRetention(await seeded(db), { apply: true, now })).retained.ambiguous_reference).toBe(2);
  });
});

describe('whole-group ledger retention and quota preservation', () => {
  it('expires complete legacy and explicit-budget groups atomically, including retry sequence isolation', async () => {
    const db = emptyDatabase(); db.ledger = [...settled('legacy'), ...settled('new:2', { budgetAt: at(62) }), posting('new:1', 'reservation', .08)];
    const store = await seeded(db), result = await runRetention(store, { apply: true, now });
    expect(result.removed.ledger).toBe(4); expect(result.retained.unsettled_or_uncertain).toBe(1); expect((await store.read()).ledger[0].operationId).toBe('new:1:reserve');
  });
  it('retains the original reservation when its terminal posting is newer, or a budget reference remains current', async () => {
    const db = emptyDatabase(), recent = settled('recent'); recent[1].createdAt = now.toISOString();
    const currentBudget = settled('metadata'); currentBudget[1].budgetAt = now.toISOString(); db.ledger = [...recent, ...currentBudget];
    const result = await runRetention(await seeded(db), { apply: true, now });
    expect(result.removed.ledger).toBe(0); expect(result.retained.not_expired).toBe(2); expect(result.retained.current_budget_reference).toBe(2);
  });
  it('holds uncertain, orphan, duplicate-terminal and corrupt reservation metadata groups', async () => {
    const db = emptyDatabase(), duplicate = settled('duplicate'), uncertain = settled('uncertain'), corrupt = settled('corrupt', { budgetAt: at(63) });
    db.ledger = [...duplicate, { ...duplicate[1], id: randomUUID() }, ...uncertain, posting('uncertain', 'uncertain', 0), posting('orphan', 'settlement', -.08), ...corrupt];
    const store = await seeded(db), result = await runRetention(store, { apply: true, now });
    expect(result.removed.ledger).toBe(0); expect(result.retained.unsettled_or_uncertain).toBe(3); expect(result.retained.ambiguous_ledger).toBe(6); expect((await store.read()).ledger).toEqual(db.ledger);
  });
  it('expires a deleted queued job\'s released group but preserves a deleted running job\'s uncertain commitment', async () => {
    const db = emptyDatabase();
    db.ledger = [posting('deleted-queued:1', 'reservation', .08), posting('deleted-queued:1', 'settlement', -.08), posting('deleted-running:1', 'reservation', .08), posting('deleted-running:1', 'uncertain', 0)];
    const store = await seeded(db), result = await runRetention(store, { apply: true, now });
    expect(result.removed.ledger).toBe(2); expect(result.retained.unsettled_or_uncertain).toBe(2); expect((await store.read()).ledger.map(entry => entry.kind)).toEqual(['reservation', 'uncertain']);
  });
  it('holds duplicate IDs across otherwise unrelated groups so an ID filter cannot remove a protected row', async () => {
    const db = emptyDatabase(), eligible = settled('eligible'), protectedRow = posting('pending', 'reservation', .08, { id: eligible[0].id }); db.ledger = [...eligible, protectedRow];
    const store = await seeded(db); expect((await runRetention(store, { apply: true, now })).removed.ledger).toBe(0); expect((await store.read()).ledger).toEqual(db.ledger);
  });
  it('keeps old voice allocations when a saved legacy attempt lacks its durable cumulative counter', async () => {
    const { database, session } = await completed(); delete session.usage.voiceAllocatedSeconds;
    const voice = { version: 1, key: 'voice:synthetic', operation: 'transcribe', requestId: randomUUID(), fingerprint: 'synthetic', seconds: 5, characters: 0, reservedUsd: .08, state: 'settled' };
    database.ledger = settled('voice:synthetic', { sessionId: session.id }).map(entry => ({ ...entry, voice }));
    const store = await seeded(database); expect((await runRetention(store, { apply: true, now })).retained.legacy_voice_counter).toBe(2);
    await store.transaction(db => { db.sessions[session.id].usage.voiceAllocatedSeconds = 5; }); expect((await runRetention(store, { apply: true, now })).removed.ledger).toBe(2);
  });
  it('preserves current daily/monthly/global quota and admission counters after old deletion metadata expires', async () => {
    const db = emptyDatabase();
    db.ledger = [...settled('eligible-old'), ...settled('current', { createdAt: now.toISOString(), budgetAt: now.toISOString() }), posting('other-owner', 'reservation', .04, { ownerId: 'other-owner', createdAt: now.toISOString() }), posting('admission-old', 'admission', 0), posting('admission-current', 'admission', 0, { createdAt: now.toISOString() })];
    db.deletions = [deletion('synthetic-deleted-session')];
    const before = budgetTotals(db.ledger, owner, now.toISOString()), currentAdmissions = db.ledger.filter(entry => entry.kind === 'admission' && entry.createdAt.slice(0, 10) === now.toISOString().slice(0, 10));
    const store = await seeded(db); await runRetention(store, { apply: true, now }); const after = await store.read();
    expect(budgetTotals(after.ledger, owner, now.toISOString())).toEqual(before); expect(before.userDailyUsd).toBeCloseTo(.02); expect(before.globalDailyUsd).toBeCloseTo(.06);
    expect(after.ledger.filter(entry => entry.kind === 'admission' && entry.createdAt.slice(0, 10) === now.toISOString().slice(0, 10))).toEqual(currentAdmissions);
    expect(after.deletions).toEqual([]);
  });
  it('never expires old ledger groups belonging to an active attempt', async () => {
    const { database, session } = await completed(); session.lifecycle = 'active'; database.ledger = settled('active', { sessionId: session.id });
    expect((await runRetention(await seeded(database), { apply: true, now })).retained.active_obligation).toBe(2);
  });
});

describe('maintenance CLI with isolated local storage', () => {
  const cli = (path: string, args: string[] = [], production = false) => spawnSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', 'scripts/retention.ts', ...args], {
    cwd: resolve('.'), env: { NODE_ENV: production ? 'production' : 'test', DATABASE_URL: '', PRACTICE_DATA_PATH: path, PATH: process.env.PATH }, encoding: 'utf8', timeout: 15_000,
  });
  it('supports help, dry-run and explicit apply without initializing billing or providers', async () => {
    const root = await directory(), path = join(root, 'practice.json'), db = emptyDatabase(); request(db, { deleted: true }, { createdAt: old }); await writeFile(path, JSON.stringify(db));
    expect(cli(path, ['--help']).stdout).toContain('Usage:'); const dry = cli(path); expect(dry.status).toBe(0); expect(JSON.parse(dry.stdout).mode).toBe('dry-run'); expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).requests)).toHaveLength(1);
    const applied = cli(path, ['--apply', '--max-rows', '1']); expect(applied.status).toBe(0); expect(JSON.parse(applied.stdout).removed.requests).toBe(1); expect(Object.keys(JSON.parse(await readFile(path, 'utf8')).requests)).toHaveLength(0);
  });
  it('returns safe fixed failures for bad options and production without a database', async () => {
    const path = join(await directory(), 'practice.json'), bad = cli(path, ['--unexpected-private-value']);
    expect(bad.status).toBe(1); expect(JSON.parse(bad.stderr)).toEqual({ event: 'retention.failed', category: 'invalid_options' }); expect(bad.stderr).not.toContain('unexpected-private-value');
    expect(cli(path, ['--apply', '--dry-run']).status).toBe(1);
    const unavailable = cli(path, [], true); expect(unavailable.status).toBe(1); expect(JSON.parse(unavailable.stderr).category).toBe('storage_or_policy_unavailable'); await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
