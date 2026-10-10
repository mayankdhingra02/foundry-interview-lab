import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingIntent, readPendingRequests, writePendingRequests } from '../features/interview-practice/recovery';

const wire = { scenarioId: 'fixture', mode: 'practice', role: 'Backend engineer', level: 'Mid-level', skills: ['reasoning'], targetMinutes: 60, aiHelp: true, voice: false, requestId: 'original-creation-key' };
const record = (payload: unknown) => ({ payload: JSON.stringify(payload), uncertain: true, createdAt: new Date().toISOString() });
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
});
afterEach(() => vi.unstubAllGlobals());
describe('additive accommodation and timing retry recovery', () => {
  it('preserves original legacy wire identity and typed choices exactly', () => {
    for (const payload of [wire, { ...wire, practiceConditions: { timing: 'extra-15', participation: 'written-only' } }]) {
      const original = record(payload); writePendingRequests('owner', 'creation', new Map([['create', original]]));
      expect(readPendingRequests('owner', 'creation').get('create')).toEqual(original);
    }
  });
  it('rejects free-text, unsupported or partially specified conditions instead of stripping them', () => {
    for (const practiceConditions of [{ timing: 'standard', participation: 'written-only', health: 'PRIVATE' }, { timing: 'unlimited', participation: 'written-only' }, { timing: 'standard' }]) {
      expect(() => writePendingRequests('owner', 'creation', new Map([['create', record({ ...wire, practiceConditions })]]))).toThrow('could not be validated');
    }
  });
  it('reloads the original extension amount, revision and request key as an explicit retry candidate', () => {
    const intent = JSON.stringify({ path: 'timing', body: { additionalMinutes: 30 } });
    const original = record({ additionalMinutes: 30, expectedRevision: 3, requestId: 'original-extension-key' });
    writePendingRequests('owner', 'session:fixture', new Map([[intent, original]]));
    expect(pendingIntent(intent)).toEqual({ path: 'timing', body: { additionalMinutes: 30 } });
    expect(readPendingRequests('owner', 'session:fixture').get(intent)).toEqual(original);
    expect(readPendingRequests('other-owner', 'session:fixture').size).toBe(0);
    expect(() => writePendingRequests('owner', 'session:fixture', new Map([[intent, record({ additionalMinutes: 15, expectedRevision: 3, requestId: 'original-extension-key' })]]))).toThrow('could not be validated');
  });
});
