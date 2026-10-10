import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../lib/interview-practice/domain';
import type { RunExecution } from '../lib/interview-practice/types';
import { canaryPlan, parseCanaryArguments, runDisposableCanary, type CanaryFixtureExecutor } from '../lib/server/canary';
import { FilePracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { syntheticRuntimeId } from './runtime-fixtures';

const options = { context: 'disposable-local' as const, isolatedExecutionHost: true, env: { PYTHON_IMAGE_ID: syntheticRuntimeId } };
const execute = vi.fn<CanaryFixtureExecutor['execute']>(async (scenario, _files, admitted): Promise<RunExecution> => ({
  status: 'completed', command: 'INJECTED CONTRACT FIXTURE; no container executed', stdout: '', stderr: '', exitCode: 0,
  durationMs: 1, runtimeDigest: admitted.runtimeBinding!.imageId,
  tests: scenario.tests.map(test => ({ id: test.id, title: test.title, status: 'passed' })),
}));
const driver = (): CanaryFixtureExecutor => ({ execute, health: () => ({ blockedReason: null }) });
const notices: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); execute.mockClear(); for (const path of notices.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('zero-action canary operator interface', () => {
  it('defaults to a zero-action plan and requires an explicit separate execution context', () => {
    expect(parseCanaryArguments([])).toEqual({ mode: 'plan', context: 'disposable-local', isolatedExecutionHost: false });
    expect(canaryPlan()).toMatchObject({ mode: 'plan', actionsPerformed: 0 });
    expect(parseCanaryArguments(['--run','--context','disposable-local','--acknowledge-isolated-execution-host'])).toMatchObject({ mode: 'run', isolatedExecutionHost: true });
    for (const args of [['--run'], ['--run','--context','disposable-local'], ['--run','--acknowledge-isolated-execution-host'], ['--context','production'], ['--plan','--run'], ['--source','evil.py'], ['--output','learner-history.json'], ['--context','disposable-local','--context','disposable-local']]) expect(() => parseCanaryArguments(args)).toThrow();
  });
  it('actual CLI default does not initialize a configured database, store, provider or Docker', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, ['--conditions=react-server','--import','tsx',resolve('scripts/operations/canary.ts')], { env: { NODE_ENV: 'test', PATH: process.env.PATH, DATABASE_URL: 'invalid://must-never-connect', PRACTICE_DATA_PATH: '/must-not-create/practice.json', OPENAI_API_KEY: 'not-a-live-key', PYTHON_IMAGE_ID: undefined }, stdio: ['ignore','pipe','pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('exit', code => resolveResult({ code, stdout, stderr }));
    });
    expect(result.code).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'plan', actionsPerformed: 0 });
  });
  it('rejects invalid context or missing reviewed pin before creating storage or executing', async () => {
    const transaction = vi.spyOn(FilePracticeStore.prototype, 'transaction');
    for (const candidate of [{ ...options, isolatedExecutionHost: false }, { ...options, env: {} }, { ...options, env: { PYTHON_IMAGE_ID: 'python:latest' } }, { ...options, env: { PYTHON_IMAGE_ID: syntheticRuntimeId, RUNNER_MODE: 'remote' } }]) {
      const result = await runDisposableCanary(candidate, driver());
      expect(result.status).toBe('failed'); expect(result.cleanup.storage).toBe('not-created'); expect(result.counts.sessions).toBe(0);
    }
    expect(transaction).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('does not reset an existing cleanup hold or create a canary context', async () => {
    const result = await runDisposableCanary(options, { execute, health: () => ({ blockedReason: 'existing hold' }) });
    expect(result).toMatchObject({ status: 'failed', category: 'cleanup_unconfirmed', operatorActionRequired: true, cleanup: { storage: 'not-created', execution: 'not-started' } });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('disposable durable canary contracts; execution is injected, never Docker qualification', () => {
  it('saves/replays/reloads before execution, freezes matching facts, persists a synthetic report, then erases only its context', async () => {
    const directories = new Set<string>(), actualRead = FilePracticeStore.prototype.read;
    vi.spyOn(FilePracticeStore.prototype,'read').mockImplementation(function (this: FilePracticeStore) { directories.add(this.directory); return actualRead.call(this); });
    const fetch = vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Canary must never contact providers.'));
    const admission = vi.spyOn(SessionService.prototype,'requestRun'), completion = vi.spyOn(SessionService.prototype,'completeJob');
    const fixtureDriver = driver();
    fixtureDriver.execute = async (scenario, files, admitted) => {
      const directory = [...directories][0], database = JSON.parse(await readFile(join(directory,'practice.json'),'utf8'));
      const saved = Object.values(database.sessions)[0] as Awaited<ReturnType<SessionService['exportSession']>>;
      expect(saved.ownerId).toMatch(/^[a-f0-9-]{36}$/); expect(saved.configuration).toMatchObject({ aiHelp: false, voice: false });
      expect(saved.snapshots).toHaveLength(2); expect(saved.snapshots[1].sha256).toBe(digest(files));
      expect(saved.snapshots[1].files).toEqual(files); expect(files['solution.py']).toContain('Original synthetic canary save.');
      expect(saved.jobs[0]).toMatchObject({ kind: 'run', state: 'running', snapshotId: saved.snapshots[1].id, reservedUsd: 0 });
      expect(admitted).toMatchObject({ includeProtected: true, runtimeBinding: { imageId: syntheticRuntimeId } });
      expect(scenario.id).toBe('operations-canary'); expect(scenario.tests).toHaveLength(1); expect(scenario.tests[0].source).toContain('unittest.TestCase');
      expect((await stat(directory)).mode & 0o777).toBe(0o700); expect((await stat(join(directory,'practice.json'))).mode & 0o777).toBe(0o600);
      return execute(scenario, files, admitted);
    };
    const result = await runDisposableCanary(options, fixtureDriver);
    expect(result).toMatchObject({ status: 'passed', category: 'complete', evidenceScope: 'injected-contract-fixture', counts: { sessions: 1, saves: 1, runs: 1, reports: 1, providerCalls: 0, modelSpendUsd: 0 }, cleanup: { storage: 'removed', execution: 'fixture-asserted' }, operatorActionRequired: false });
    expect(Object.values(result.checks).every(Boolean)).toBe(true); expect(directories.size).toBe(1);
    await expect(stat([...directories][0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(admission).toHaveBeenCalledOnce(); expect(completion.mock.calls.map(call => call[1].kind)).toEqual(['run','interviewer','coach']);
    expect(fetch).not.toHaveBeenCalled();
    const coach = completion.mock.calls[2][1];
    expect(coach.kind).toBe('coach');
    if (coach.kind === 'coach') { expect(coach.model).toBe('authored-observation-only'); expect(coach.inference).toBeUndefined(); expect(coach.report.overview).toContain('does not assess your skill'); expect(coach.report.rubric.every(row => row.level === 'Not observed')).toBe(true); }
    expect(result.limitations.join(' ')).toContain('no real container');
    expect(JSON.stringify(result)).not.toContain('solution.py'); expect(JSON.stringify(result)).not.toContain('return a + b');
  });
  it('keeps simultaneous synthetic runs in different private directories and identities', async () => {
    const owners = new Set<string>(), directories = new Set<string>(), actualRead = FilePracticeStore.prototype.read;
    vi.spyOn(FilePracticeStore.prototype,'read').mockImplementation(async function (this: FilePracticeStore) {
      directories.add(this.directory); const database = await actualRead.call(this);
      for (const session of Object.values(database.sessions)) owners.add(session.ownerId);
      return database;
    });
    const results = await Promise.all([runDisposableCanary(options,driver()),runDisposableCanary(options,driver())]);
    expect(results.every(result => result.status === 'passed')).toBe(true); expect(directories.size).toBe(2); expect(owners.size).toBe(2);
    for (const directory of directories) await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['missing-pin','wrong-pin','unknown-check','missing-check','failed-check','infrastructure'])('never publishes a successful canary or report for %s execution evidence', async failure => {
    const fixtureDriver = driver(); fixtureDriver.execute = async (scenario, files, admitted) => {
      const run = await execute(scenario,files,admitted);
      if (failure === 'missing-pin') delete run.runtimeDigest;
      if (failure === 'wrong-pin') run.runtimeDigest = `sha256:${'b'.repeat(64)}`;
      if (failure === 'unknown-check') run.tests[0].id = 'unadmitted-test';
      if (failure === 'missing-check') run.tests = [];
      if (failure === 'failed-check') { run.tests[0].status = 'failed'; run.exitCode = 1; }
      if (failure === 'infrastructure') { run.status = 'infrastructure_error'; run.tests = []; run.exitCode = null; }
      return run;
    };
    const result = await runDisposableCanary(options,fixtureDriver);
    expect(result.status).toBe('failed'); expect(result.counts.reports).toBe(0); expect(result.cleanup.storage).toBe('removed'); expect(result.checks.sessionErased).toBe(true);
  });
  it('retains only a content-free durable notice when runner cleanup cannot be confirmed', async () => {
    let blocked = false;
    const fixtureDriver: CanaryFixtureExecutor = { health: () => ({ blockedReason: blocked ? 'cleanup not confirmed' : null }), execute: async (...args) => { blocked = true; return execute(...args); } };
    const result = await runDisposableCanary(options,fixtureDriver);
    expect(result).toMatchObject({ status: 'failed', category: 'cleanup_unconfirmed', operatorActionRequired: true, counts: { reports: 0 }, cleanup: { storage: 'retained-notice', execution: 'unconfirmed' } });
    expect(result.cleanupNoticePath).toBeDefined();
    const directory = resolve(result.cleanupNoticePath!,'..'); notices.push(directory);
    expect(await readdir(directory)).toEqual(['cleanup-hold.json']);
    const notice = await readFile(result.cleanupNoticePath!,'utf8');
    expect(JSON.parse(notice).category).toBe('execution_cleanup_unconfirmed'); expect(notice).not.toContain('solution.py'); expect(notice).not.toContain(syntheticRuntimeId);
    expect((await stat(result.cleanupNoticePath!)).mode & 0o777).toBe(0o600);
  });
  it('treats an unexpected executor rejection as uncertain cleanup without leaking its message', async () => {
    const result = await runDisposableCanary(options,{ ...driver(), execute: async () => { throw new Error('PRIVATE RAW TRACE'); } });
    expect(result).toMatchObject({ status: 'failed', category: 'policy_or_storage_failed', operatorActionRequired: true, cleanup: { storage: 'retained-notice', execution: 'unconfirmed' } });
    notices.push(resolve(result.cleanupNoticePath!,'..')); expect(JSON.stringify(result)).not.toContain('PRIVATE RAW TRACE');
  });
  it('rejects an interrupted run before any durable context or executor exists', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await runDisposableCanary({ ...options, signal: controller.signal },driver());
    expect(result).toMatchObject({ status: 'failed', category: 'interrupted', cleanup: { storage: 'not-created', execution: 'not-started' } }); expect(execute).not.toHaveBeenCalled();
  });
  it('fails on incorrect durable reload instead of continuing to execution', async () => {
    const original = SessionService.prototype.exportSession;
    vi.spyOn(SessionService.prototype,'exportSession').mockImplementation(async function (this: SessionService, ...args) { const session = await original.apply(this,args); session.snapshots.at(-1)!.sha256 = 'corrupted'; return session; });
    const result = await runDisposableCanary(options,driver());
    expect(result).toMatchObject({ status: 'failed', category: 'durability_validation_failed', cleanup: { storage: 'removed' } }); expect(execute).not.toHaveBeenCalled();
  });
  it('does not report success if policy erasure fails even when final temporary-file removal succeeds', async () => {
    vi.spyOn(SessionService.prototype,'deleteAccount').mockRejectedValue(new Error('private cleanup diagnostic'));
    const result = await runDisposableCanary(options,driver());
    expect(result).toMatchObject({ status: 'failed', category: 'storage_cleanup_failed', cleanup: { storage: 'removed' }, checks: { sessionErased: false } });
    expect(JSON.stringify(result)).not.toContain('private cleanup diagnostic');
  });
});
