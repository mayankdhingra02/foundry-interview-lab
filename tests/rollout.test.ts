import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getScenario, listScenarios } from '../lib/content/scenarios';
import { capabilities } from '../lib/server/config';
import { admittedScenarios, assertPracticeAdmission, assertScenarioAdmission, rolloutAdmissionPolicy } from '../lib/server/rollout';
import { MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { processOneJob } from '../lib/server/worker';
import { coach } from '../lib/ai/provider';
import { freezeEvidence } from '../lib/interview-practice/evidence';

const staff = '11dc5c01-f748-46b7-b699-0b55f316a3c6';
const invited = '5222fa22-120a-4cf5-89ed-7dad687b3c9b';
const outsider = '73efbd73-729b-4b58-80ab-8c67240ef3db';
const scenario = getScenario('monetary-validation')!;
let sequence = 0;
const requestId = () => `rollout-test-${++sequence}`;
const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('PRACTICE_ADMISSION_MODE', undefined);
  vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', undefined); vi.stubEnv('ADMIN_USER_IDS', ''); vi.stubEnv('INVITED_PRACTICE_USER_IDS', '');
  vi.stubEnv('FEATURE_REPORT_GENERATION', undefined); vi.stubEnv('FEATURE_AI_INTERVIEW', 'true');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-test-key-never-sent'); vi.stubEnv('OPENAI_MODEL', 'gpt-5.4-mini');
  vi.stubEnv('OPENAI_INPUT_USD_PER_MILLION', '.75'); vi.stubEnv('OPENAI_OUTPUT_USD_PER_MILLION', '4.5');
  vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '2400'); vi.stubEnv('FEATURE_BILLING', 'false');
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('new-practice scenario release gate', () => {
  it('defaults to all known scenarios locally and none in production', () => {
    expect(admittedScenarios(listScenarios()).map(item => item.id)).toEqual(listScenarios().map(item => item.id));
    expect(() => assertScenarioAdmission(scenario.id)).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(admittedScenarios(listScenarios())).toEqual([]);
    expect(() => assertScenarioAdmission(scenario.id)).toThrow(expect.objectContaining({ status: 403, code: 'scenario_not_admitted' }));
  });

  it('admits only exact known IDs and preserves generic caller metadata', () => {
    vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', ' duplicate-invoice, monetary-validation ');
    const rows = [{ id: 'monetary-validation', card: 'visible' }, { id: 'event-rollup', card: 'retired' }, { id: 'not-a-package', card: 'unknown' }];
    expect(admittedScenarios(rows)).toEqual([rows[0]]);
    expect(() => assertScenarioAdmission('monetary-validation')).not.toThrow();
    for (const id of ['monetary', 'monetary-validation-extra', 'not-a-package', '__proto__']) expect(() => assertScenarioAdmission(id)).toThrow();
  });

  it.each(['unknown-package', '*', 'monetary-validation,', ',monetary-validation', 'monetary-validation,,duplicate-invoice', 'monetary-validation,monetary-validation', 'MONETARY-VALIDATION', 'monetary-validation\nduplicate-invoice'])('fails closed for malformed or unknown scenario configuration %s', value => {
    vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', value);
    expect(admittedScenarios(listScenarios())).toEqual([]);
    expect(() => assertScenarioAdmission(scenario.id)).toThrow(expect.objectContaining({ status: 503, code: 'rollout_unconfigured' }));
  });

  it('treats an explicit empty allowlist as retiring all tasks without removing original packages', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const session = (await service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() })).session;
    vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', '');
    expect(admittedScenarios(listScenarios())).toEqual([]);
    expect(() => assertScenarioAdmission(scenario.id)).toThrow();
    expect(getScenario(session.scenarioId, session.scenarioVersion)).toEqual(scenario);
    const saved = await service.saveWorkspace(outsider, session.id, { requestId: requestId(), expectedRevision: session.revision, files: session.files });
    expect((await service.getSession(outsider, session.id)).revision).toBe(saved.session.revision);
    expect((await service.listSessions(outsider)).map(item => item.id)).toEqual([session.id]);
  });
});

describe('verified-owner rollout admission and billing ordering', () => {
  it('defaults local admission to open and production admission to exact staff IDs', () => {
    expect(() => assertPracticeAdmission(outsider)).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => assertPracticeAdmission(outsider)).toThrow(expect.objectContaining({ status: 403, code: 'practice_not_admitted' }));
    vi.stubEnv('ADMIN_USER_IDS', staff);
    expect(() => assertPracticeAdmission(staff)).not.toThrow();
    expect(() => assertPracticeAdmission(invited)).toThrow();
  });

  it('allows staff plus explicitly invited owners in invite mode without prefix/email/case matching', () => {
    vi.stubEnv('PRACTICE_ADMISSION_MODE', 'invite'); vi.stubEnv('ADMIN_USER_IDS', staff); vi.stubEnv('INVITED_PRACTICE_USER_IDS', ` ${invited} `);
    expect(() => assertPracticeAdmission(staff)).not.toThrow(); expect(() => assertPracticeAdmission(invited)).not.toThrow();
    for (const id of [outsider, invited.slice(0, 8), `${invited}-extra`, invited.toUpperCase(), 'learner@example.com', '']) expect(() => assertPracticeAdmission(id)).toThrow();
    vi.stubEnv('PRACTICE_ADMISSION_MODE', 'staff'); expect(() => assertPracticeAdmission(invited)).toThrow();
  });

  it.each(['public', 'OPEN', ' open ', '', '*'])('fails closed on invalid admission mode %s', mode => {
    vi.stubEnv('PRACTICE_ADMISSION_MODE', mode);
    expect(() => assertPracticeAdmission(staff)).toThrow(expect.objectContaining({ status: 503, code: 'rollout_unconfigured' }));
  });

  it.each(['*', 'learner@example.com', 'fixture-owner', `${staff},`, `${staff},${staff}`, staff.toUpperCase(), `${staff},invalid`])('rejects a malformed user allowlist instead of accepting the valid subset %s', value => {
    for (const key of ['ADMIN_USER_IDS', 'INVITED_PRACTICE_USER_IDS']) {
      vi.stubEnv('PRACTICE_ADMISSION_MODE', 'open'); vi.stubEnv(key, value);
      expect(() => assertPracticeAdmission(staff)).toThrow(expect.objectContaining({ code: 'rollout_unconfigured' }));
      vi.stubEnv(key, '');
    }
  });

  it('rejects before billing side effects and preserves transactional admission and request replay', async () => {
    vi.stubEnv('PRACTICE_ADMISSION_MODE', 'invite'); vi.stubEnv('INVITED_PRACTICE_USER_IDS', invited);
    const billing = vi.fn(async (context: Parameters<ReturnType<typeof rolloutAdmissionPolicy>>[0]) => {
      context.database.ledger.push({ id: 'synthetic-debit', ownerId: context.ownerId, sessionId: context.sessionId, operationId: context.requestId, kind: 'admission', amountUsd: 0, createdAt: context.now });
    });
    const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario, { admissionPolicy: rolloutAdmissionPolicy(billing) });
    await expect(service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() })).rejects.toMatchObject({ status: 403 });
    expect(billing).not.toHaveBeenCalled(); expect((await store.read()).sessions).toEqual({}); expect((await store.read()).ledger).toEqual([]);
    const input = { scenarioId: scenario.id, requestId: requestId() };
    const first = await service.createSession(invited, input); expect(await service.createSession(invited, input)).toEqual(first);
    expect(billing).toHaveBeenCalledOnce(); expect(billing.mock.calls[0][0].ownerId).toBe(invited);
    vi.stubEnv('INVITED_PRACTICE_USER_IDS', '');
    expect(await service.createSession(invited, input)).toEqual(first);
    await expect(service.createSession(invited, { scenarioId: scenario.id, requestId: requestId() })).rejects.toMatchObject({ status: 403 });
    expect(billing).toHaveBeenCalledOnce();
    expect((await service.listSessions(invited)).map(item => item.id)).toEqual([first.session.id]);
  });

  it('replays an acknowledged creation after retirement while rejecting genuinely new admission before billing', async () => {
    const billing = vi.fn(async (context: Parameters<ReturnType<typeof rolloutAdmissionPolicy>>[0]) => { void context; });
    const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario, { admissionPolicy: rolloutAdmissionPolicy(billing) });
    const input = { scenarioId: scenario.id, requestId: requestId() };
    const first = await service.createSession(outsider, input);
    expect(billing).toHaveBeenCalledOnce();
    expect(billing.mock.calls[0][0]).toMatchObject({ scenarioId: scenario.id, scenarioVersion: scenario.version });
    const before = await store.read();
    vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', '');
    expect(await service.createSession(outsider, input)).toEqual(first);
    await expect(service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() })).rejects.toMatchObject({ code: 'scenario_not_admitted' });
    expect(billing).toHaveBeenCalledOnce(); expect(await store.read()).toEqual(before);
    expect(getScenario(first.session.scenarioId, first.session.scenarioVersion)).toEqual(scenario);
  });

  it('does not re-evaluate closed or malformed rollout policy for an exact successful replay', async () => {
    const billing = vi.fn(async () => undefined);
    const service = new SessionService(new MemoryPracticeStore(), getScenario, { admissionPolicy: rolloutAdmissionPolicy(billing) });
    const input = { scenarioId: scenario.id, requestId: requestId() }, first = await service.createSession(outsider, input);
    vi.stubEnv('PRACTICE_ADMITTED_SCENARIOS', 'unknown-package'); vi.stubEnv('PRACTICE_ADMISSION_MODE', 'invalid-mode');
    expect(await service.createSession(outsider, input)).toEqual(first);
    await expect(service.createSession(outsider, { ...input, requestId: requestId() })).rejects.toMatchObject({ code: 'rollout_unconfigured' });
    await expect(service.createSession(outsider, { ...input, mode: 'simulation' })).rejects.toMatchObject({ code: 'conflict' });
    expect(billing).toHaveBeenCalledOnce();
  });

  it('propagates billing rejection and leaves no partially admitted session', async () => {
    const billing = vi.fn(async () => { throw new Error('Synthetic entitlement rejection'); });
    const store = new MemoryPracticeStore(), service = new SessionService(store, getScenario, { admissionPolicy: rolloutAdmissionPolicy(billing) });
    await expect(service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() })).rejects.toThrow('Synthetic entitlement rejection');
    expect(billing).toHaveBeenCalledOnce(); expect((await store.read()).sessions).toEqual({});
  });
});

describe('independent paid coaching gate', () => {
  it('keeps interviewer/assistant inference available when AI report generation is disabled', () => {
    vi.stubEnv('FEATURE_REPORT_GENERATION', 'false');
    expect(capabilities()).toMatchObject({ ai: true, interviewer: true, assistant: true, coaching: false });
    expect(capabilities().details.coaching).toContain('disabled');
    vi.stubEnv('FEATURE_REPORT_GENERATION', 'true'); expect(capabilities().coaching).toBe(true);
    vi.stubEnv('FEATURE_AI_INTERVIEW', 'false'); expect(capabilities()).toMatchObject({ ai: false, coaching: false, interviewer: false, assistant: false });
  });

  it('defaults report inference off in production and treats malformed flags as disabled', () => {
    expect(capabilities().coaching).toBe(true);
    vi.stubEnv('NODE_ENV', 'production'); expect(capabilities().coaching).toBe(false);
    vi.stubEnv('FEATURE_REPORT_GENERATION', 'true'); expect(capabilities().coaching).toBe(true);
    for (const flag of ['', 'TRUE', '1', 'yes']) { vi.stubEnv('FEATURE_REPORT_GENERATION', flag); expect(capabilities().coaching).toBe(false); }
    vi.stubEnv('FEATURE_REPORT_GENERATION', 'true'); vi.stubEnv('OPENAI_API_KEY', '');
    expect(capabilities()).toMatchObject({ ai: false, coaching: false });
    expect(capabilities().details.coaching).toContain('unavailable');
  });

  it('does not call a provider for a paid coach job queued before the gate closed', async () => {
    vi.stubEnv('FEATURE_REPORT_GENERATION', 'true');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    let session = (await service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() })).session;
    const finish = await service.command(outsider, session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'finish' });
    await service.cancelJob(outsider, finish.job!.id, { requestId: requestId() }); session = await service.getSession(outsider, session.id);
    const submitted = await service.command(outsider, session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'submit' });
    expect(submitted.job!.reservedUsd).toBeGreaterThan(0);
    expect((await service.exportSession(outsider, session.id)).jobs.at(-1)!.input.forceAuthored).not.toBe(true);
    const frozen = structuredClone(submitted.session.frozenEvidence);
    vi.stubEnv('FEATURE_REPORT_GENERATION', 'false');
    await processOneJob(service);
    const completed = await service.getSession(outsider, session.id);
    expect(fetch).not.toHaveBeenCalled(); expect(completed.lifecycle).toBe('completed'); expect(completed.frozenEvidence).toEqual(frozen);
    expect(completed.reports[0]).toMatchObject({ model: 'authored-observation-only' });
    expect(completed.reports[0].rubric.every(finding => finding.level === 'Not observed')).toBe(true);
    expect(completed.usage.spentUsd).toBe(0); expect(completed.usage.reservedUsd).toBe(0);
  });

  it('rechecks the report gate inside the provider path and preserves input evidence', async () => {
    const service = new SessionService(new MemoryPracticeStore(), getScenario);
    const created = await service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() });
    const session = await service.exportSession(outsider, created.session.id); session.frozenEvidence = freezeEvidence(session, new Date().toISOString());
    const before = JSON.stringify(session), fetch = vi.fn(); vi.stubGlobal('fetch', fetch); vi.stubEnv('FEATURE_REPORT_GENERATION', 'false');
    expect(await coach(scenario, session)).toMatchObject({ kind: 'coach', model: 'authored-observation-only', actualUsd: 0 });
    expect(fetch).not.toHaveBeenCalled(); expect(JSON.stringify(session)).toBe(before);
  });

  it('sets the application coach reservation to zero and enforces rollout for new attempts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-rollout-')); directories.push(directory);
    vi.stubEnv('DATABASE_URL', ''); vi.stubEnv('PRACTICE_DATA_PATH', join(directory, 'practice.json')); vi.stubEnv('FEATURE_REPORT_GENERATION', 'false');
    vi.stubEnv('PRACTICE_ADMISSION_MODE', 'staff'); vi.stubEnv('ADMIN_USER_IDS', staff);
    vi.resetModules();
    const { getService } = await import('../lib/server/application');
    const service = await getService();
    await expect(service.createSession(outsider, { scenarioId: scenario.id, requestId: requestId() })).rejects.toMatchObject({ code: 'practice_not_admitted' });
    let session = (await service.createSession(staff, { scenarioId: scenario.id, requestId: requestId() })).session;
    const finish = await service.command(staff, session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'finish' });
    await service.cancelJob(staff, finish.job!.id, { requestId: requestId() }); session = await service.getSession(staff, session.id);
    const result = await service.command(staff, session.id, { requestId: requestId(), expectedRevision: session.revision, action: 'submit' });
    expect(result.job!.reservedUsd).toBe(0);
    expect((await service.exportSession(staff, session.id)).jobs.at(-1)!.input.forceAuthored).toBe(true);
  });
});
