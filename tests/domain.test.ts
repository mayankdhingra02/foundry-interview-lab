import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { digest, toPublicScenario } from '../lib/interview-practice/domain';
import { validateReport } from '../lib/interview-practice/evidence';
import type { CoachOutput, Scenario } from '../lib/interview-practice/types';
import { FilePracticeStore, MemoryPracticeStore } from '../lib/server/store';
import { SessionService } from '../lib/server/session-service';

const scenario: Scenario = {
  id: 'fixture', version: '1', title: 'Test fixture', summary: 'Synthetic domain fixture, not a provider evaluation.', durationMinutes: 30, level: 'mid', tags: ['correctness'], language: 'python',
  files: { 'main.py': 'def add(a, b): return a - b\n' },
  stages: [{ id: 'debug', title: 'Debug', brief: 'Fix addition', requirements: ['Return a sum'] }, { id: 'debrief', title: 'Debrief', brief: 'Explain work', requirements: [] }],
  rubric: [{ id: 'correctness', name: 'Correctness', description: 'Behavior', anchors: { strong: 'Works', developing: 'Partially works', needsWork: 'Incorrect' } }, { id: 'communication', name: 'Communication', description: 'Explanation', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Unclear' } }],
  probes: [{ id: 'p1', stageId: 'debrief', competencyId: 'correctness', question: 'What did you verify?' }], hints: ['Compare the operation with the requirement.'],
  tests: [{ id: 'sum', title: 'Adds two values', source: 'assert add(1, 2) == 3', visible: true, timeoutSeconds: 2 }, { id: 'private', title: 'Edge case', source: 'PRIVATE-CHECK', visible: false, timeoutSeconds: 2 }],
  referenceFiles: { 'main.py': 'REFERENCE-SOLUTION' }, drills: [{ id: 'drill', title: 'Addition', competencyId: 'correctness', lesson: 'Check a small example', exercise: 'Try negatives' }], rights: 'Original synthetic fixture', runtime: { image: 'python:3.11-slim', timeoutSeconds: 5, memoryMb: 128 },
};
let sequence = 0;
const request = () => `request-${++sequence}`;
const mutation = (revision: number) => ({ requestId: request(), expectedRevision: revision });
const create = async (service: SessionService, owner = 'owner-a') => (await service.createSession(owner, { scenarioId: scenario.id, requestId: request() })).session;
const serviceFor = (options = {}) => new SessionService(new MemoryPracticeStore(), () => structuredClone(scenario), options);
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('deterministic session ownership and mutation contracts', () => {
  it('removes references, probe answers, hints and private test source from public packages', () => {
    const publicValue = JSON.stringify(toPublicScenario(scenario));
    expect(publicValue).not.toContain('PRIVATE-CHECK'); expect(publicValue).not.toContain('REFERENCE-SOLUTION');
    expect(publicValue).not.toContain('Compare the operation'); expect(toPublicScenario(scenario).tests[0].source).toContain('assert');
  });
  it('canonical hashes are independent of file key insertion order', () => {
    expect(digest({ 'b.py': 'b', 'a.py': 'a' })).toBe(digest({ 'a.py': 'a', 'b.py': 'b' }));
  });
  it('denies cross-owner reads and keeps request keys owner scoped', async () => {
    const service = serviceFor(), key = request();
    const a = await service.createSession('owner-a', { scenarioId: scenario.id, requestId: key });
    const b = await service.createSession('owner-b', { scenarioId: scenario.id, requestId: key });
    expect(a.session.id).not.toBe(b.session.id);
    await expect(service.getSession('owner-b', a.session.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(service.exportSession('owner-b', a.session.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('replays exact duplicate admission without another session and rejects changed input', async () => {
    const service = serviceFor(), key = request(), input = { scenarioId: scenario.id, requestId: key };
    expect(await service.createSession('owner-a', input)).toEqual(await service.createSession('owner-a', input));
    expect(await service.listSessions('owner-a')).toHaveLength(1);
    await expect(service.createSession('owner-a', { ...input, mode: 'simulation' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('admits only one of two simultaneous writes with the same revision', async () => {
    const service = serviceFor(), session = await create(service);
    const results = await Promise.allSettled([service.saveWorkspace('owner-a', session.id, { ...mutation(session.revision), files: { 'main.py': 'A' } }), service.saveWorkspace('owner-a', session.id, { ...mutation(session.revision), files: { 'main.py': 'B' } })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const events = await service.events('owner-a', session.id, 1); expect(events.map(e => e.sequence)).toEqual([2]);
  });
  it('separates code freeze, debrief answers and final evidence freeze', async () => {
    const service = serviceFor(); let session = await create(service);
    session = (await service.command('owner-a', session.id, { ...mutation(session.revision), action: 'finish' })).session;
    expect(session.lifecycle).toBe('active'); expect(session.codeFrozenSnapshotId).toBeTruthy(); expect(session.frozenEvidence).toBeNull();
    await expect(service.saveWorkspace('owner-a', session.id, { ...mutation(session.revision), files: { 'main.py': 'changed' } })).rejects.toMatchObject({ code: 'conflict' });
    await expect(service.command('owner-a', session.id, { ...mutation(session.revision), action: 'submit' })).rejects.toMatchObject({ code: 'conflict' });
    const question = await service.claimJob('worker'); expect(question).not.toBeNull();
    await service.completeJob(question!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'ask_probe', question: 'What did you verify?', competencyId: 'correctness', probeId: 'p1', evidenceIds: [] } });
    session = await service.getSession('owner-a', session.id);
    session = (await service.commitTurn('owner-a', session.id, { ...mutation(session.revision), text: 'I checked a positive pair and a negative pair.' })).session;
    const followup = await service.claimJob('worker');
    await service.completeJob(followup!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'end_debrief', evidenceIds: [] } });
    session = await service.getSession('owner-a', session.id);
    session = (await service.command('owner-a', session.id, { ...mutation(session.revision), action: 'submit' })).session;
    expect(session.lifecycle).toBe('reviewing'); expect(session.frozenEvidence!.items.some(e => e.content.includes('negative pair'))).toBe(true);
    await expect(service.commitTurn('owner-a', session.id, { ...mutation(session.revision), text: 'late answer' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('records actual runner observations against the admitted snapshot', async () => {
    const service = serviceFor(); let session = await create(service);
    session = (await service.requestRun('owner-a', session.id, mutation(session.revision))).session;
    const claim = await service.claimJob('worker');
    session = (await service.saveWorkspace('owner-a', session.id, { ...mutation(session.revision), files: { 'main.py': 'new work' } })).session;
    await service.completeJob(claim!, { kind: 'run', run: { status: 'completed', command: 'synthetic test fixture', stdout: '', stderr: '', exitCode: 0, durationMs: 5, tests: [{ id: 'sum', title: 'Adds two values', status: 'passed' }] } });
    session = await service.getSession('owner-a', session.id);
    expect(session.runs[0].snapshotSha256).not.toBe(digest(session.files));
    expect(session.runs[0].testSuiteDigest).toBe(digest(scenario.tests));
  });
  it('rejects unknown runner tests instead of inventing evidence', async () => {
    const service = serviceFor(), session = await create(service);
    await service.requestRun('owner-a', session.id, mutation(session.revision)); const claim = await service.claimJob('worker');
    await expect(service.completeJob(claim!, { kind: 'run', run: { status: 'completed', command: 'fixture', stdout: '', stderr: '', exitCode: 0, durationMs: 1, tests: [{ id: 'invented', title: 'Invented', status: 'passed' }] } })).rejects.toMatchObject({ code: 'invalid' });
    expect((await service.getSession('owner-a', session.id)).runs).toHaveLength(0);
  });
  it('retains a completed check when a later check times out without claiming global success', async () => {
    const service = serviceFor(), session = await create(service);
    await service.requestRun('owner-a', session.id, mutation(session.revision));
    const claim = await service.claimJob('worker');
    await service.completeJob(claim!, { kind: 'run', run: { status: 'timeout', command: 'fixture', stdout: '', stderr: 'Deadline expired', exitCode: null, durationMs: 5, tests: [{ id: 'sum', title: 'Adds two values', status: 'passed' }, { id: 'private', title: 'Edge case', status: 'skipped', detail: 'No completed observation: time limit exceeded.' }] } });
    const run = (await service.getSession('owner-a', session.id)).runs[0];
    expect(run.status).toBe('timeout'); expect(run.tests.map(t => t.status)).toEqual(['passed', 'skipped']);
  });
  it('rejects stale AI edits after manual work', async () => {
    const service = serviceFor(); let session = await create(service);
    session = (await service.requestAssistant('owner-a', session.id, { ...mutation(session.revision), mode: 'edit', message: 'Fix addition' })).session;
    const claim = await service.claimJob('worker');
    await service.completeJob(claim!, { kind: 'assistant', model: 'synthetic-fixture', actualUsd: 0, message: 'Proposed edit', files: { 'main.py': 'def add(a,b): return a+b' } });
    session = await service.getSession('owner-a', session.id);
    const proposal = session.editProposals[0];
    session = (await service.saveWorkspace('owner-a', session.id, { ...mutation(session.revision), files: { 'main.py': 'my later work' } })).session;
    await expect(service.decideEdit('owner-a', session.id, { ...mutation(session.revision), proposalId: proposal.id, decision: 'accept' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await service.getSession('owner-a', session.id)).files['main.py']).toBe('my later work');
  });
});

describe('leases, cost admission, reports and deletion', () => {
  it('rejects stale worker completion after lease takeover and preserves uncertain spend', async () => {
    let clock = new Date('2026-10-09T12:00:00Z');
    const service = serviceFor({ now: () => clock, leaseMs: 1000 }); const session = await create(service);
    await service.requestAssistant('owner-a', session.id, { ...mutation(session.revision), mode: 'ask', message: 'Explain' });
    const old = await service.claimJob('old-worker'); clock = new Date(clock.getTime() + 1100);
    expect(await service.heartbeatJob(old!)).toBe(false);
    const current = await service.claimJob('new-worker'); expect(current!.fencingToken).toBeGreaterThan(old!.fencingToken);
    expect(await service.completeJob(old!, { kind: 'assistant', model: 'fixture', message: 'stale', actualUsd: 0 })).toBe(false);
    expect(await service.completeJob(current!, { kind: 'assistant', model: 'fixture', message: 'current', actualUsd: 0.01 })).toBe(true);
    const saved = await service.getSession('owner-a', session.id); expect(saved.assistantMessages.at(-1)!.text).toBe('current');
    expect(saved.usage.uncertainUsd).toBeCloseTo(0.08); expect(saved.usage.spentUsd).toBeCloseTo(0.01);
  });
  it('cancellation fences late results and duplicate cancellation is idempotent', async () => {
    const service = serviceFor(); let session = await create(service);
    const pending = await service.requestRun('owner-a', session.id, mutation(session.revision)); session = pending.session;
    const claim = await service.claimJob('worker'), key = request();
    const cancelled = await service.cancelJob('owner-a', pending.job!.id, { requestId: key });
    expect(await service.cancelJob('owner-a', pending.job!.id, { requestId: key })).toEqual(cancelled);
    expect(await service.completeJob(claim!, { kind: 'run', run: { status: 'timeout', command: 'fixture', stdout: '', stderr: '', exitCode: null, durationMs: 1, tests: [] } })).toBe(false);
  });
  it('checks budget atomically and does not reset daily admission by deleting history', async () => {
    const service = serviceFor({ maxSessionUsd: 0.01, maxDailySessions: 1 }); const session = await create(service);
    await expect(service.requestAssistant('owner-a', session.id, { ...mutation(session.revision), mode: 'ask', message: 'Explain' })).rejects.toMatchObject({ code: 'quota' });
    expect((await service.getSession('owner-a', session.id)).jobs).toHaveLength(0);
    await service.deleteSession('owner-a', session.id, { requestId: request() });
    await expect(create(service)).rejects.toMatchObject({ code: 'quota' });
  });
  it('validates report IDs, optional explanations and next-practice references', () => {
    const manifest = { digest: 'fixture', watermark: 1, frozenAt: 'now', items: [{ id: 'code', kind: 'snapshot' as const, label: 'code', content: 'a', sha256: 'digest', source: 'learner-workspace' }] };
    const report: CoachOutput = { overview: 'Fixture', rubric: [{ criterionId: 'correctness', level: 'Developing', feedback: 'Inspect the operation', evidenceIds: ['code'], confidence: 'low' }, { criterionId: 'communication', level: 'Not observed', feedback: 'No answer recorded', evidenceIds: [], confidence: 'low' }], nextPractice: [{ drillId: 'drill', reason: 'Try an example' }] };
    expect(validateReport(report, scenario, manifest)).toEqual(report);
    expect(() => validateReport({ ...report, rubric: [{ ...report.rubric[0], evidenceIds: ['unknown'] }, report.rubric[1]] }, scenario, manifest)).toThrow('evidence');
    expect(() => validateReport({ ...report, rubric: [report.rubric[0], { ...report.rubric[1], level: 'Strong', evidenceIds: ['code'] }] }, scenario, manifest)).toThrow('explanations');
  });
  it('rejects universal test claims contradicted by frozen final-snapshot observations', () => {
    const manifest = { digest: 'fixture', watermark: 1, frozenAt: 'now', items: [
      { id: 'code', kind: 'snapshot' as const, label: 'code', content: 'a', sha256: 'digest', snapshotId: 'snapshot', source: 'learner-workspace' },
      ...scenario.tests.map((t, i) => ({ id: `test:${t.id}`, kind: 'test' as const, label: t.title, content: JSON.stringify({ status: i ? 'failed' : 'passed', runStatus: 'completed' }), sha256: 'digest', snapshotId: 'snapshot', testId: t.id, runId: 'run', source: 'executed-test' })),
    ] };
    const report: CoachOutput = { overview: 'All tests passed.', rubric: [{ criterionId: 'correctness', level: 'Developing', feedback: 'Inspect the operation', evidenceIds: ['code'], confidence: 'low' }, { criterionId: 'communication', level: 'Not observed', feedback: 'No answer recorded', evidenceIds: [], confidence: 'low' }], nextPractice: [{ drillId: 'drill', reason: 'Try an example' }] };
    expect(() => validateReport(report, scenario, manifest)).toThrow('does not support');
    expect(() => validateReport({ ...report, overview: 'All tests failed.' }, scenario, manifest)).toThrow('does not support');
    expect(() => validateReport({ ...report, overview: 'Not all tests passed.' }, scenario, manifest)).not.toThrow();
  });
  it('keeps the same frozen generation on report retry and survives tab closure', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store, () => scenario); let session = await create(service);
    session = (await service.command('owner-a', session.id, { ...mutation(session.revision), action: 'finish' })).session;
    const initial = await service.claimJob('worker'); await service.completeJob(initial!, { kind: 'interviewer', model: 'authored', actualUsd: 0, proposal: { action: 'end_debrief', evidenceIds: [] } });
    session = await service.getSession('owner-a', session.id);
    await service.command('owner-a', session.id, { ...mutation(session.revision), action: 'submit' });
    const coach = await service.claimJob('worker'); await service.failJob(coach!, 'Provider unavailable', 0);
    const reloaded = new SessionService(store, () => scenario), retry = await reloaded.retryReport('owner-a', session.id, { requestId: request() });
    expect(retry.job!.id).toBe(coach!.job.id);
    const retryClaim = await reloaded.claimJob('worker-2'); expect(retryClaim!.job.input).toEqual(coach!.job.input);
    expect(retryClaim!.fencingToken).toBeGreaterThan(coach!.fencingToken);
  });
  it('uses unique ledger postings when a report is cancelled before claim and retried', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store, () => scenario); let session = await create(service);
    const finish = await service.command('owner-a', session.id, { ...mutation(session.revision), action: 'finish' });
    await service.cancelJob('owner-a', finish.job!.id, { requestId: request() }); session = await service.getSession('owner-a', session.id);
    const submitted = await service.command('owner-a', session.id, { ...mutation(session.revision), action: 'submit' });
    await service.cancelJob('owner-a', submitted.job!.id, { requestId: request() });
    const retry = await service.retryReport('owner-a', session.id, { requestId: request() });
    await service.cancelJob('owner-a', retry.job!.id, { requestId: request() });
    const ledger = (await store.read()).ledger; expect(new Set(ledger.map(l => l.operationId)).size).toBe(ledger.length);
    expect((await service.getSession('owner-a', session.id)).usage.reservedUsd).toBe(0);
  });
  it('deletes private session caches and prevents late jobs recreating content', async () => {
    const store = new MemoryPracticeStore(), service = new SessionService(store, () => scenario), key = request();
    const session = (await service.createSession('owner-a', { scenarioId: scenario.id, requestId: key })).session;
    await service.requestRun('owner-a', session.id, mutation(session.revision)); const claim = await service.claimJob('worker');
    await service.deleteSession('owner-a', session.id, { requestId: request() });
    expect(await service.exportAccount('owner-a')).toEqual([]);
    expect(JSON.stringify((await store.read()).requests)).not.toContain('def add');
    expect(await service.failJob(claim!, 'late failure', 0)).toBe(false);
    expect((await store.read()).deletions[0].state).toBe('completed');
  });
});

describe('durable local filesystem adapter', () => {
  it('persists acknowledged work for a new service process', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-store-')); temporary.push(directory);
    const first = new SessionService(new FilePracticeStore(directory), () => scenario), session = await create(first);
    const second = new SessionService(new FilePracticeStore(directory), () => scenario);
    expect((await second.getSession('owner-a', session.id)).files).toEqual(scenario.files);
    expect(JSON.parse(await readFile(join(directory, 'practice.json'), 'utf8')).schemaVersion).toBe(1);
  });
  it('serializes independent OS processes without lost writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'foundry-multiprocess-')); temporary.push(directory);
    const moduleUrl = pathToFileURL(resolve('lib/server/store.ts')).href;
    const code = `import { FilePracticeStore } from ${JSON.stringify(moduleUrl)}; const store = new FilePracticeStore(process.argv[1]); for(let i=0;i<10;i++) await store.transaction(db=>{db.deletions.push({id:crypto.randomUUID(),ownerId:'fixture',sessionId:'fixture',createdAt:new Date().toISOString(),state:'completed',objectKeys:[]});});`;
    const child = () => new Promise<void>((resolveChild, reject) => {
      const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, directory], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; processChild.stderr.on('data', chunk => { output += chunk; }); processChild.once('error', reject); processChild.once('close', status => status === 0 ? resolveChild() : reject(new Error(output)));
    });
    await Promise.all([child(), child(), child()]);
    expect((await new FilePracticeStore(directory).read()).deletions).toHaveLength(30);
  }, 20_000);
});
