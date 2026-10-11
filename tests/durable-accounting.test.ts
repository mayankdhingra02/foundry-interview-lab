import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { accountingCheckContract, assertContentFreePosting, DURABLE_USAGE_CHECK_SQL } from '../lib/interview-practice/accounting';
import { budgetTotals } from '../lib/interview-practice/quota';
import type { LedgerEntry } from '../lib/interview-practice/types';
import { durableLedgerReady, schemaCapabilitiesReady } from '../lib/server/readiness-schema';
import { SessionService } from '../lib/server/session-service';
import { MemoryPracticeStore } from '../lib/server/store';
import { inferenceBindingFromPolicy } from '../lib/ai/binding';
import { getScenario } from '../lib/content/scenarios';
import { readySchema } from './readiness-fixtures';

const at = '2026-10-11T12:00:00.321Z';
const posting = (extra: Partial<LedgerEntry> = {}): LedgerEntry => ({ id: randomUUID(), ownerId: randomUUID(), sessionId: randomUUID(), operationId: `${randomUUID()}:1:reserve`, kind: 'reservation', amountUsd: .08, createdAt: at, budgetAt: at, ...extra });

describe('durable content-free usage boundary', () => {
  it('pins the append-only SQL CHECK to the reviewed runtime contract without weakening predicates', async () => {
    const migration = await readFile(new URL('../supabase/migrations/202610090011_durable_usage_ledger.sql', import.meta.url), 'utf8');
    const expression = migration.split('add constraint ai_practice_usage_content_free check (')[1].split(';\nalter table')[0];
    expect(accountingCheckContract(expression)).toBe(accountingCheckContract(DURABLE_USAGE_CHECK_SQL));
    expect(migration).toContain('drop constraint ai_practice_usage_ledger_user_id_fkey');
    expect(migration).not.toMatch(/delete from|update public\.ai_practice_usage_ledger/i);
  });

  it('accepts the literal actual PostgreSQL17 deparse, including uppercase IS NOT NULL, but rejects a widened predicate', async () => {
    const definition = await readFile(new URL('./fixtures/durable-usage-pg17-check.sql', import.meta.url), 'utf8');
    const row = readySchema().find(item => item.name === 'ai_practice_usage_ledger')!;
    row.checks.find(item => item.name === 'ai_practice_usage_content_free')!.definition = definition;
    expect(durableLedgerReady(row)).toBe(true);
    row.checks.find(item => item.name === 'ai_practice_usage_content_free')!.definition = definition.replace('<= 8192', '<= 1048576');
    expect(durableLedgerReady(row)).toBe(false);
  });

  it('accepts current and valid legacy postings but refuses content, invalid negative money and invalid clocks', () => {
    const valid = posting(); expect(() => assertContentFreePosting(valid)).not.toThrow();
    const legacy = { ...valid }; delete legacy.budgetAt; expect(() => assertContentFreePosting(legacy)).not.toThrow();
    for (const value of [{ ...valid, source: 'PRIVATE-CODE' }, { ...valid, providerBody: {} }, { ...valid, amountUsd: -.08 }, { ...valid, amountUsd: NaN }, { ...valid, budgetAt: 'invalid' }, { ...valid, budgetAt: '2026-10-12T12:00:00Z' }, { ...valid, operationId: 'x'.repeat(161) }]) {
      expect(() => assertContentFreePosting(value)).toThrow('Existing commitments were preserved');
    }
  });

  it('allows only bounded matching voice allocation metadata, never transcript/audio/provider output', () => {
    const key = `voice:${randomUUID()}`, voice = { version: 1, key, operation: 'transcribe', requestId: randomUUID(), fingerprint: 'a'.repeat(64), seconds: 1, characters: 0, reservedUsd: .08, state: 'reserved', expiresAt: '2026-10-11T12:02:00.321Z' };
    const entry = { ...posting(), operationId: `${key}:reserved`, voice }; expect(() => assertContentFreePosting(entry)).not.toThrow();
    for (const changed of [{ ...voice, transcript: 'PRIVATE-TRANSCRIPT' }, { ...voice, audio: 'PRIVATE-AUDIO' }, { ...voice, seconds: 121 }, { ...voice, characters: 1.5 }, { ...voice, reservedUsd: .04 }, { ...voice, expiresAt: 'invalid' }]) expect(() => assertContentFreePosting({ ...entry, voice: changed })).toThrow();
  });

  it('requires actual no-FK, private ACL, validated exact CHECK and immutable UPDATE enforcement', () => {
    const schema = readySchema(), row = schema.find(item => item.name === 'ai_practice_usage_ledger')!;
    expect(durableLedgerReady(row)).toBe(true); expect(schemaCapabilitiesReady(schema)).toBe(true);
    for (const mutate of [
      (copy: typeof row) => { copy.foreignKeyCount = 1; },
      (copy: typeof row) => { delete copy.foreignKeyCount; },
      (copy: typeof row) => { copy.authenticatedSelect = true; },
      (copy: typeof row) => { copy.serviceTruncate = true; },
      (copy: typeof row) => { copy.triggers.find(item => item.name === 'ai_practice_usage_immutable')!.enabled = 'D'; },
      (copy: typeof row) => { copy.checks.find(item => item.name === 'ai_practice_usage_content_free')!.validated = false; },
      (copy: typeof row) => { copy.checks.find(item => item.name === 'ai_practice_usage_content_free')!.definition += ' OR true'; },
      (copy: typeof row) => { copy.checks.find(item => item.name === 'ai_practice_usage_content_free')!.definition = 'CHECK (true)'; },
    ]) { const copy = structuredClone(row); mutate(copy); expect(durableLedgerReady(copy)).toBe(false); }
  });

  it('holds running closed-owner commitments globally without rewriting the reservation or admitting another owner', async () => {
    const owner = randomUUID(), other = randomUUID(), store = new MemoryPracticeStore();
    const service = new SessionService(store, getScenario, { now: () => new Date(at), maxGlobalDailyUsd: .1, inferenceBinding: role => inferenceBindingFromPolicy(role, { model: 'synthetic-no-call', inputRate: 1, outputRate: 10 / 3, maxOutput: 2400 }) });
    const session = (await service.createSession(owner, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
    await service.requestAssistant(owner, session.id, { requestId: randomUUID(), expectedRevision: session.revision, mode: 'ask', message: 'PRIVATE-QUESTION' });
    const claim = (await service.claimJob('synthetic-no-provider-worker'))!, before = (await store.read()).ledger;
    await service.closeAccount(owner, { requestId: randomUUID() });
    const closed = await store.read(); expect(closed.ledger.slice(0, before.length)).toEqual(before);
    expect(budgetTotals(closed.ledger, other, at)).toEqual({ userDailyUsd: 0, userMonthlyUsd: 0, globalDailyUsd: .08 });
    expect(JSON.stringify(closed)).not.toContain('PRIVATE-QUESTION');
    const next = (await service.createSession(other, { scenarioId: 'monetary-validation', requestId: randomUUID() })).session;
    await expect(service.requestAssistant(other, next.id, { requestId: randomUUID(), expectedRevision: next.revision, mode: 'ask', message: 'Synthetic request.' })).rejects.toMatchObject({ code: 'quota' });
    expect(await service.failJob(claim, 'Synthetic late outcome', 0)).toBe(false);
    expect(budgetTotals((await store.read()).ledger, other, at).globalDailyUsd).toBe(.08);
  });

  it('keeps deleted-owner holds in their original UTC window and never treats uncertainty/orphan credits as refunds', () => {
    const reserve = posting({ createdAt: '2026-10-31T23:59:59Z', budgetAt: '2026-10-31T23:59:59Z' });
    const uncertain = { ...reserve, id: randomUUID(), kind: 'uncertain' as const, operationId: reserve.operationId.replace(':reserve', ':uncertain'), amountUsd: 0, createdAt: '2026-11-01T00:00:01Z' };
    const credit = { ...uncertain, id: randomUUID(), kind: 'settlement' as const, operationId: reserve.operationId.replace(':reserve', ':settle'), amountUsd: -.08 };
    expect(budgetTotals([reserve, uncertain, credit], 'another-owner', reserve.createdAt).globalDailyUsd).toBe(.08);
    expect(budgetTotals([reserve, uncertain, credit], 'another-owner', uncertain.createdAt).globalDailyUsd).toBe(0);
    expect(budgetTotals([{ ...credit, operationId: 'orphan:settle' }, reserve], 'another-owner', reserve.createdAt).globalDailyUsd).toBe(.08);
  });

  it.each(['admission', 'reservation', 'uncertain'] as const)('fails closed on malformed negative %s rather than creating allowance', kind => {
    expect(() => budgetTotals([posting({ kind, amountUsd: -.08 })], 'another-owner', at)).toThrow('operator review');
  });
});
