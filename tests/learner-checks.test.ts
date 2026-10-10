import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScenario } from '../lib/content/scenarios';
import { digest, textDigest, validateFiles } from '../lib/interview-practice/domain';
import { LEARNER_CHECK_POLICY as policy } from '../lib/interview-practice/check-policy';
import { admittedRunSuite, selectRunSuite } from '../lib/interview-practice/learner-checks';
import { freezeEvidence, validateReport } from '../lib/interview-practice/evidence';
import type { CoachOutput, RunExecution } from '../lib/interview-practice/types';
import { FilePracticeStore, MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';
import { processOneJob } from '../lib/server/worker';
import * as runtime from '../lib/runtime/runner';
import * as operations from '../lib/server/operations';
import { fixtureRuntimeId } from './runtime-fixtures';

const scenario = () => getScenario('monetary-validation')!;
const source = 'import unittest\nfrom quote import quote_total\nclass Regression(unittest.TestCase):\n    def test_empty(self):\n        self.assertEqual(quote_total([]), 0)\n';
const mutation = (expectedRevision: number) => ({ requestId: randomUUID(), expectedRevision });
const runResult = (tests: RunExecution['tests']): RunExecution => ({ status: 'completed', command: 'Injected check fixture; no container executed', stdout: '', stderr: '', exitCode: tests.some(t => t.status === 'failed' || t.status === 'error') ? 1 : 0, durationMs: 1, runtimeDigest: fixtureRuntimeId, tests });
const checkResult = () => runResult([{ id: policy.testId, title: 'Learner-authored regression check', status: 'passed' }]);
const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory,{ recursive: true,force: true }); });
const serviceFor = (store = new MemoryPracticeStore()) => new SessionService(store,getScenario);
async function withCheck(service: SessionService) {
  let session = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: randomUUID() })).session;
  session = (await service.saveWorkspace('owner',session.id,{ ...mutation(session.revision),files: { ...session.files,[policy.path]: source } })).session;
  return session;
}
function report(overview: string): CoachOutput {
  return { overview,rubric: scenario().rubric.map(c => ({ criterionId: c.id,level: 'Not observed',confidence: 'low',feedback: 'No independent skill assessment.',evidenceIds: [] })),nextPractice: [{ drillId: scenario().drills[0].id,reason: 'Authored practice link.' }] };
}

describe('additive bounded learner check workspace policy', () => {
  it('preserves original packages/default files and only permits the fixed optional slot', () => {
    const original = scenario(), before = digest(original);
    expect(validateFiles(original.files,original)).toEqual(original.files);
    expect(validateFiles({ ...original.files,[policy.path]: source },original)[policy.path]).toBe(source);
    expect(digest(scenario())).toBe(before); expect(original.files).not.toHaveProperty(policy.path);
    for (const path of ['arbitrary.py','../learner_checks.py','_foundry_contract.py','checks/learner_checks.py']) expect(() => validateFiles({ ...original.files,[path]: source },original)).toThrow();
    for (const text of ['x'.repeat(8001),'é'.repeat(4001),'bad\0source']) expect(() => validateFiles({ ...original.files,[policy.path]: text },original)).toThrow();
    expect(validateFiles({ ...original.files,[policy.path]: 'é'.repeat(4000) },original)[policy.path]).toHaveLength(4000);
  });
  it('keeps the full authored suite selected by default and never merges learner source into protected contracts', () => {
    const original = scenario(), files = { ...original.files,[policy.path]: source };
    expect(selectRunSuite(original,files).tests).toEqual(original.tests);
    const learner = selectRunSuite(original,files,'learner');
    expect(learner.tests).toHaveLength(1); expect(learner.tests[0]).toMatchObject({ id: policy.testId,source,timeoutSeconds: 3 });
    expect(learner.learnerCheck).toEqual({ workspacePolicyVersion: 1,executionPolicyVersion: 1,path: policy.path,sourceSha256: textDigest(source) });
    expect(learner.tests.some(test => original.tests.some(authored => authored.id === test.id))).toBe(false);
    expect(() => selectRunSuite(original,original.files,'learner')).toThrow();
    expect(() => selectRunSuite(original,{ ...files,[policy.path]: '  ' },'learner')).toThrow();
    expect(() => selectRunSuite({ ...original,files: { ...original.files,[policy.path]: 'authored legacy content' } },files,'learner')).toThrow();
  });
  it('binds exact source/suite/policy and rejects unsupported or mislabeled admitted selection', () => {
    const original = scenario(), files = { ...original.files,[policy.path]: source }, suite = selectRunSuite(original,files,'learner');
    const input = { selection: 'learner',learnerCheck: suite.learnerCheck,testSuiteDigest: digest(suite.tests) };
    expect(admittedRunSuite(original,files,input)).toEqual(suite);
    for (const bad of [{ ...input,selection: 'shell' },{ ...input,testSuiteDigest: digest(original.tests) },{ ...input,learnerCheck: { ...suite.learnerCheck,executionPolicyVersion: 2 } },{ ...input,learnerCheck: { ...suite.learnerCheck,sourceSha256: 'a'.repeat(64) } }]) expect(() => admittedRunSuite(original,files,bad)).toThrow();
    expect(() => admittedRunSuite(original,{ ...files,[policy.path]: source+'# changed' },input)).toThrow();
    expect(admittedRunSuite(original,original.files,{ testSuiteDigest: digest(original.tests) }).tests).toEqual(original.tests);
  });
});

describe('snapshot admission, completion and evidence provenance', () => {
  it('durably saves check source in the existing snapshot and preserves legacy snapshot bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(),'foundry-checks-test-')); directories.push(directory);
    const service = new SessionService(new FilePracticeStore(directory),getScenario);
    const created = (await service.createSession('owner',{ scenarioId: scenario().id,requestId: randomUUID() })).session;
    const original = (await service.exportSession('owner',created.id)).snapshots[0];
    await service.saveWorkspace('owner',created.id,{ ...mutation(created.revision),files: { ...created.files,[policy.path]: source } });
    const restarted = new SessionService(new FilePracticeStore(directory),getScenario), stored = await restarted.exportSession('owner',created.id);
    expect(stored.snapshots[0]).toEqual(original); expect(stored.scenarioDigest).toBe(digest(scenario()));
    expect(stored.snapshots[1].files[policy.path]).toBe(source); expect(stored.snapshots[1].sha256).toBe(digest(stored.snapshots[1].files));
  });
  it('replays defaults compatibly, distinguishes explicit learner selection and checks missing source atomically', async () => {
    const store = new MemoryPracticeStore(), service = serviceFor(store), session = await withCheck(service);
    const input = mutation(session.revision), first = await service.requestRun('owner',session.id,input);
    expect(await service.requestRun('owner',session.id,{ ...input,selection: 'authored' })).toEqual(first);
    await expect(service.requestRun('owner',session.id,{ ...input,selection: 'learner' })).rejects.toMatchObject({ code: 'conflict' });
    const other = serviceFor(), blank = (await other.createSession('owner',{ scenarioId: scenario().id,requestId: randomUUID() })).session;
    const before = await other.store.read();
    await expect(other.requestRun('owner',blank.id,{ ...mutation(blank.revision),selection: 'learner' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await other.store.read()).toEqual(before);
  });
  it('uses the old admitted source after later edits and cannot label learner observations as protected results', async () => {
    const service = serviceFor(); let session = await withCheck(service);
    session = (await service.requestRun('owner',session.id,{ ...mutation(session.revision),selection: 'learner' })).session;
    const claim = (await service.claimJob('checks-worker'))!;
    session = (await service.saveWorkspace('owner',session.id,{ ...mutation(session.revision),files: { ...session.files,[policy.path]: source+'# later edit\n' } })).session;
    const before = await service.store.read();
    await expect(service.completeJob(claim,{ kind: 'run',run: runResult([{ ...scenario().tests[0],status: 'passed' }]) })).rejects.toMatchObject({ code: 'invalid' });
    await expect(service.completeJob(claim,{ kind: 'run',run: runResult([]) })).rejects.toMatchObject({ code: 'invalid' });
    expect(await service.store.read()).toEqual(before);
    expect(await service.completeJob(claim,{ kind: 'run',run: checkResult() })).toBe(true);
    const stored = await service.exportSession('owner',session.id), run = stored.runs[0];
    expect(run.learnerCheck?.sourceSha256).toBe(textDigest(source)); expect(run.snapshotSha256).not.toBe(digest(stored.files));
    expect(run.testSuiteDigest).toBe(digest(selectRunSuite(scenario(),stored.snapshots.find(s => s.id === run.snapshotId)!.files,'learner').tests));
    await service.deleteSession('owner',session.id,{ requestId: randomUUID() });
    expect(await service.completeJob(claim,{ kind: 'run',run: checkResult() })).toBe(false);
  });
  it('derives authored origin from admission even when a worker supplies an extra forged learner label', async () => {
    const service = serviceFor(), session = await withCheck(service);
    await service.requestRun('owner',session.id,mutation(session.revision)); const claim = (await service.claimJob('worker'))!;
    const execution = { ...runResult(scenario().tests.map(test => ({ id: test.id,title: test.title,status: 'passed' }))),learnerCheck: { fake: true } };
    await service.completeJob(claim,{ kind: 'run',run: execution });
    expect((await service.getSession('owner',session.id)).runs[0]).not.toHaveProperty('learnerCheck');
  });
  it('freezes source/suite/runtime bindings and never lets a learner-only pass establish authored/protected success', async () => {
    const service = serviceFor(), session = await withCheck(service);
    await service.requestRun('owner',session.id,{ ...mutation(session.revision),selection: 'learner' }); const claim = (await service.claimJob('worker'))!;
    await service.completeJob(claim,{ kind: 'run',run: checkResult() });
    const stored = await service.exportSession('owner',session.id), manifest = freezeEvidence(stored,'2026-10-09T12:00:00.000Z');
    const fact = manifest.items.find(item => item.kind === 'test')!;
    expect(fact.source).toBe('learner-authored-check');
    expect(JSON.parse(fact.content)).toMatchObject({ learnerCheck: { workspacePolicyVersion: 1,executionPolicyVersion: 1,path: policy.path,sourceSha256: textDigest(source) },runtimeDigest: fixtureRuntimeId,testSuiteDigest: stored.runs[0].testSuiteDigest });
    for (const text of ['All tests passed.','Every authored check passed.','All protected tests passed.','Protected tests passed.','The protected suite now passes.','Authored contracts have passed.','All scenario tests failed.']) expect(() => validateReport(report(text),scenario(),manifest)).toThrow();
    expect(() => validateReport(report('All learner checks passed. This is not independent correctness evidence.'),scenario(),manifest)).not.toThrow();
    expect(() => validateReport(report('No authored contract outcome was observed.'),scenario(),manifest)).not.toThrow();
    expect(manifest.items.some(item => item.file === policy.path && item.content === source)).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(scenario().tests.find(test => !test.visible)!.source);
  });
  it('rejects a global all-pass claim when authored checks failed and a separate learner check passed', async () => {
    const service = serviceFor(); let session = await withCheck(service);
    await service.requestRun('owner',session.id,mutation(session.revision)); let claim = (await service.claimJob('worker'))!;
    await service.completeJob(claim,{ kind: 'run',run: runResult(scenario().tests.map(test => ({ id: test.id,title: test.title,status: 'failed' }))) });
    session = await service.getSession('owner',session.id);
    await service.requestRun('owner',session.id,{ ...mutation(session.revision),selection: 'learner' }); claim = (await service.claimJob('worker'))!;
    await service.completeJob(claim,{ kind: 'run',run: checkResult() });
    const manifest = freezeEvidence(await service.exportSession('owner',session.id),'2026-10-09T12:00:00.000Z');
    expect(() => validateReport(report('All tests passed.'),scenario(),manifest)).toThrow();
    expect(() => validateReport(report('All authored tests failed; all learner checks passed.'),scenario(),manifest)).not.toThrow();
  });
});

describe('learner check worker boundaries with injected execution only', () => {
  it('executes the admitted learner snapshot using the existing pin/hold path', async () => {
    vi.spyOn(operations,'executionAdmissionOpen').mockResolvedValue(true);
    const execute = vi.spyOn(runtime,'executeScenario').mockResolvedValue(checkResult());
    const service = serviceFor(); let session = await withCheck(service);
    session = (await service.requestRun('owner',session.id,{ ...mutation(session.revision),selection: 'learner' })).session;
    await service.saveWorkspace('owner',session.id,{ ...mutation(session.revision),files: { ...session.files,[policy.path]: source+'# newer\n' } });
    await processOneJob(service,'learner-worker');
    expect(execute).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({ [policy.path]: source }),expect.objectContaining({ selection: 'learner',includeProtected: true,runtimeBinding: expect.objectContaining({ imageId: fixtureRuntimeId }) }));
    expect((await service.getSession('owner',session.id)).runs[0].learnerCheck?.sourceSha256).toBe(textDigest(source));
  });
  it('rejects tampered policy/source before execution and preserves a safe technical failure', async () => {
    vi.spyOn(operations,'executionAdmissionOpen').mockResolvedValue(true);
    const execute = vi.spyOn(runtime,'executeScenario'), service = serviceFor(), session = await withCheck(service);
    await service.requestRun('owner',session.id,{ ...mutation(session.revision),selection: 'learner' });
    await service.store.transaction(db => {
      const job = db.sessions[session.id].jobs[0]; job.input.learnerCheck = { executionPolicyVersion: 999 }; job.fingerprint = digest(job.input);
    });
    await processOneJob(service,'tamper-worker');
    expect(execute).not.toHaveBeenCalled();
    expect((await service.getSession('owner',session.id)).jobs[0]).toMatchObject({ state: 'failed',actualUsd: 0 });
  });

  it('fences a learner-check result when its run is cancelled during execution', async () => {
    vi.spyOn(operations,'executionAdmissionOpen').mockResolvedValue(true);
    const service = serviceFor(), session = await withCheck(service);
    const admitted = await service.requestRun('owner',session.id,{ ...mutation(session.revision),selection: 'learner' });
    vi.spyOn(runtime,'executeScenario').mockImplementation(async () => {
      await service.cancelJob('owner',admitted.job!.id,{ requestId: randomUUID() });
      return checkResult();
    });
    await processOneJob(service,'cancel-worker');
    const saved = await service.getSession('owner',session.id);
    expect(saved.jobs[0].state).toBe('cancelled'); expect(saved.runs).toHaveLength(0);
  });
});
