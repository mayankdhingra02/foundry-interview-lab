import 'server-only';

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest } from '../interview-practice/domain';
import type { CoachOutput, JobClaim, JobKind, RunExecution, Scenario, Session } from '../interview-practice/types';
import { configuredRuntimeBinding, parseRuntimeBinding } from '../runtime/binding';
import { executeScenario, runnerHealth, type ExecuteOptions } from '../runtime/runner';
import { SessionService } from './session-service';
import { FilePracticeStore } from './store';

/** Original operations fixture. Never register this package in the learner catalog or benchmark. */
function fixture(): Scenario {
  return {
    id: 'operations-canary', version: '1', title: 'Synthetic operations canary',
    summary: 'Disposable component check; no learner or model assessment.', durationMinutes: 5,
    level: 'synthetic', tags: ['synthetic-operations'], language: 'python',
    files: { 'solution.py': 'def add(a, b):\n    return a + b\n' },
    stages: [
      { id: 'verify', title: 'Synthetic save', brief: 'Save the original harmless fixture.', requirements: ['Return the sum of two integers.'] },
      { id: 'debrief', title: 'Synthetic debrief', brief: 'No learner explanation or assessment.', requirements: [] },
    ],
    rubric: [{ id: 'synthetic-observation', name: 'Synthetic observation', description: 'No skill assessment.', anchors: { strong: 'Not assessed', developing: 'Not assessed', needsWork: 'Not assessed' } }],
    probes: [{ id: 'synthetic-probe', stageId: 'debrief', competencyId: 'synthetic-observation', question: 'This is an automated synthetic component check. No learner answer is required.' }],
    hints: [],
    tests: [{ id: 'harmless-addition', title: 'Original harmless addition check', visible: true, timeoutSeconds: 2,
      source: 'import unittest\nfrom solution import add\n\nclass CanaryAddition(unittest.TestCase):\n    def test_known_values(self):\n        self.assertEqual(add(2, 3), 5)\n        self.assertEqual(add(-2, 2), 0)\n' }],
    referenceFiles: {},
    drills: [{ id: 'synthetic-only', title: 'Synthetic fixture', competencyId: 'synthetic-observation', lesson: 'No learner recommendation.', exercise: 'Operations component check only.' }],
    rights: 'Original Engineering Foundry synthetic operations fixture; excluded from learner and expert benchmark counts.',
    runtime: { image: 'python:3.11-slim', timeoutSeconds: 10, memoryMb: 128 },
  };
}

function syntheticReport(): CoachOutput {
  return {
    overview: 'SYNTHETIC OPERATIONS CANARY — observation-only report. No learner, AI or expert assessment was performed. This checks the frozen-evidence report path only.',
    rubric: [{ criterionId: 'synthetic-observation', level: 'Not observed', confidence: 'low', evidenceIds: [], feedback: 'Synthetic fixture only; no learner skill is assessed.' }],
    nextPractice: [{ drillId: 'synthetic-only', reason: 'Synthetic operations fixture only; no measured learner weakness or practice recommendation.' }],
  };
}

export function canaryPlan() {
  return {
    version: 1, mode: 'plan', actionsPerformed: 0, context: 'disposable-local',
    requirements: ['Explicit --run --context disposable-local --acknowledge-isolated-execution-host.', 'An already provisioned dedicated disposable or approved separate Docker execution context.', 'A reviewed, locally cached PYTHON_IMAGE_ID sha256 pin; no pull or alias fallback.'],
    plannedActions: ['Create one synthetic owner and a new private temporary FilePracticeStore.', 'Create, save, replay and reload one built-in harmless fixture through SessionService.', 'Admit and claim one pinned run; execute through the existing isolated runner and validate completion.', 'Finish coding, complete one authored question, Final submit, and persist one observation-only synthetic report.', 'Reload and validate frozen report evidence, erase the synthetic session, and remove task-owned storage.'],
    excluded: ['Learner stores/accounts/catalog/history', 'Database, model, voice or billing initialization', 'Hosted monitoring or release qualification', 'Docker pull, restart, prune, global cleanup or admission reset'],
  } as const;
}

export type CanaryArguments = { mode: 'plan' | 'run'; context: 'disposable-local'; isolatedExecutionHost: boolean };
export function parseCanaryArguments(args: string[]): CanaryArguments {
  let mode: 'plan' | 'run' = 'plan', modeChosen = false, contextChosen = false, isolatedExecutionHost = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--plan' || arg === '--run') {
      if (modeChosen) throw new Error('invalid_options');
      mode = arg === '--run' ? 'run' : 'plan'; modeChosen = true;
    } else if (arg === '--context') {
      if (contextChosen || args[++index] !== 'disposable-local') throw new Error('invalid_options');
      contextChosen = true;
    } else if (arg === '--acknowledge-isolated-execution-host') {
      if (isolatedExecutionHost) throw new Error('invalid_options');
      isolatedExecutionHost = true;
    } else throw new Error('invalid_options');
  }
  if (mode === 'run' && (!contextChosen || !isolatedExecutionHost)) throw new Error('isolated_context_required');
  return { mode, context: 'disposable-local', isolatedExecutionHost };
}

/** Injection is for deterministic contracts, and always downgrades the result's evidence scope. */
export type CanaryFixtureExecutor = {
  execute: (scenario: Scenario, files: Record<string, string>, options: ExecuteOptions) => Promise<RunExecution>;
  health: () => { blockedReason: string | null };
};
export type CanaryResult = {
  version: 1; context: 'disposable-local'; evidenceScope: 'local-component-execution' | 'injected-contract-fixture';
  status: 'passed' | 'failed'; category: string; durationMs: number;
  checks: { durableSave: boolean; exactReplay: boolean; pinnedRun: boolean; harmlessCheckPassed: boolean; frozenEvidence: boolean; syntheticReport: boolean; durableReport: boolean; sessionErased: boolean };
  counts: { sessions: number; saves: number; runs: number; reports: number; providerCalls: 0; modelSpendUsd: 0 };
  cleanup: { storage: 'not-created' | 'removed' | 'retained-notice' | 'unconfirmed'; execution: 'not-started' | 'runner-confirmed' | 'fixture-asserted' | 'unconfirmed' };
  operatorActionRequired: boolean; cleanupNoticePath?: string;
  limitations: string[];
};
class CanaryFailure extends Error {
  constructor(readonly category: string) { super(category); }
}
function requireCheck(condition: unknown, category: string): asserts condition {
  if (!condition) throw new CanaryFailure(category);
}

/**
 * No application singleton, configured persistence adapter, auth identity,
 * learner catalog, provider or commerce client is consulted. The only external
 * execution is the existing runner on the operator-acknowledged canary daemon.
 */
export async function runDisposableCanary(
  options: { context: 'disposable-local'; isolatedExecutionHost: boolean; env?: Record<string, string | undefined>; signal?: AbortSignal },
  injected?: CanaryFixtureExecutor,
): Promise<CanaryResult> {
  const started = performance.now(), scenario = fixture();
  const result: CanaryResult = {
    version: 1, context: 'disposable-local', evidenceScope: injected ? 'injected-contract-fixture' : 'local-component-execution',
    status: 'failed', category: 'not_started', durationMs: 0,
    checks: { durableSave: false, exactReplay: false, pinnedRun: false, harmlessCheckPassed: false, frozenEvidence: false, syntheticReport: false, durableReport: false, sessionErased: false },
    counts: { sessions: 0, saves: 0, runs: 0, reports: 0, providerCalls: 0, modelSpendUsd: 0 },
    cleanup: { storage: 'not-created', execution: 'not-started' }, operatorActionRequired: false,
    limitations: ['Disposable local FileStore component canary, not a hosted identity/database/scheduler/alert check.', 'No provider inference, voice, billing, expert evaluation or learner artifacts.', ...(injected ? ['Execution was injected: this result provides no real container, host or runtime qualification.'] : ['One harmless isolated execution does not establish adversarial sandbox security or hosted availability.'])],
  };
  let directory: string | undefined, service: SessionService | undefined, ownerId: string | undefined, sessionId: string | undefined;
  let executionStarted = false;
  const health = injected?.health ?? runnerHealth;
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000), ...(options.signal ? [options.signal] : [])]);
  const ensureActive = () => requireCheck(!signal.aborted, 'interrupted');
  try {
    requireCheck(options.context === 'disposable-local' && options.isolatedExecutionHost === true, 'isolated_context_required');
    // Pass a separate explicit environment object, so no test configuration
    // default or later environment change can substitute for operator admission.
    const binding = configuredRuntimeBinding(scenario, { ...(options.env ?? process.env) });
    requireCheck(binding, 'runtime_unconfigured');
    requireCheck((options.env ?? process.env).RUNNER_MODE === undefined || (options.env ?? process.env).RUNNER_MODE === 'docker', 'runtime_unconfigured');
    if (health().blockedReason !== null) { result.operatorActionRequired = true; throw new CanaryFailure('cleanup_unconfirmed'); }
    ensureActive();
    directory = await mkdtemp(join(tmpdir(), 'foundry-component-canary-'));
    const store = new FilePracticeStore(directory);
    const resolve = (id: string, version?: string) => id === scenario.id && (version === undefined || version === scenario.version) ? structuredClone(scenario) : null;
    const createService = () => new SessionService(new FilePracticeStore(directory!), resolve, { runtimeBinding: () => binding, reservations: { run: 0, interviewer: 0, assistant: 0, coach: 0 }, maxRuns: 1, maxDailySessions: 1, maxActiveSessions: 1, leaseMs: 120_000 });
    service = createService(); ownerId = randomUUID();
    let session = (await service.createSession(ownerId, { scenarioId: scenario.id, requestId: randomUUID(), mode: 'practice', aiHelp: false, voice: false })).session;
    sessionId = session.id; result.counts.sessions = 1;
    const files = { 'solution.py': scenario.files['solution.py'] + '\n# Original synthetic canary save.\n' };
    const save = { requestId: randomUUID(), expectedRevision: session.revision, files };
    const acknowledgedSave = await service.saveWorkspace(ownerId, sessionId, save);
    session = acknowledgedSave.session; result.counts.saves = 1;
    result.checks.exactReplay = digest(await service.saveWorkspace(ownerId, sessionId, save)) === digest(acknowledgedSave);
    service = createService();
    const saved = await service.exportSession(ownerId, sessionId), snapshot = saved.snapshots.at(-1);
    result.checks.durableSave = Boolean(snapshot && snapshot.sha256 === digest(files) && digest(snapshot.files) === snapshot.sha256 && digest(saved.files) === digest(files) && saved.snapshots.length === 2);
    requireCheck(result.checks.durableSave && result.checks.exactReplay, 'durability_validation_failed');
    ensureActive();
    session = (await service.requestRun(ownerId, sessionId, { requestId: randomUUID(), expectedRevision: session.revision })).session;

    const claim = async (kind: JobKind): Promise<{ claim: JobClaim; stored: Session }> => {
      ensureActive();
      const claimed = await service!.claimJob(`canary-${randomUUID()}`, [kind]);
      requireCheck(claimed && claimed.job.kind === kind && claimed.job.ownerId === ownerId && claimed.job.sessionId === sessionId, 'job_identity_invalid');
      const stored = await service!.exportSession(ownerId!, sessionId!);
      const admitted = stored.snapshots.find(row => row.id === claimed.job.snapshotId);
      requireCheck(stored.scenarioDigest === digest(scenario) && admitted && admitted.sha256 === digest(admitted.files) && claimed.job.fingerprint === digest(claimed.job.input), 'admitted_input_invalid');
      if (kind !== 'run') requireCheck(claimed.job.input.forceAuthored === true && claimed.job.reservedUsd === 0, 'provider_policy_invalid');
      return { claim: claimed, stored };
    };
    const run = await claim('run'), admitted = run.stored.snapshots.find(row => row.id === run.claim.job.snapshotId)!;
    const admittedBinding = parseRuntimeBinding(run.claim.job.input.runtimeBinding, scenario.runtime.image);
    requireCheck(admittedBinding && admittedBinding.imageId === binding.imageId && run.claim.job.input.testSuiteDigest === digest(scenario.tests) && digest(run.claim.job.input.runtime) === digest(scenario.runtime) && admitted.id === snapshot!.id, 'admitted_input_invalid');
    executionStarted = true; result.counts.runs = 1;
    const execution = await (injected?.execute ?? executeScenario)(scenario, structuredClone(admitted.files), { signal, includeProtected: true, runtimeBinding: admittedBinding });
    if (health().blockedReason !== null) { result.cleanup.execution = 'unconfirmed'; result.operatorActionRequired = true; throw new CanaryFailure('cleanup_unconfirmed'); }
    result.cleanup.execution = injected ? 'fixture-asserted' : 'runner-confirmed';
    requireCheck(await service.completeJob(run.claim, { kind: 'run', run: execution, actualUsd: 0 }), 'worker_fenced');
    result.checks.pinnedRun = execution.runtimeDigest === binding.imageId;
    result.checks.harmlessCheckPassed = execution.status === 'completed' && execution.exitCode === 0 && execution.tests.length === 1 && execution.tests[0].id === scenario.tests[0].id && execution.tests[0].status === 'passed';
    requireCheck(result.checks.pinnedRun && result.checks.harmlessCheckPassed, 'execution_failed');

    session = await service.getSession(ownerId, sessionId);
    await service.command(ownerId, sessionId, { requestId: randomUUID(), expectedRevision: session.revision, action: 'finish' });
    const question = await claim('interviewer'), probe = scenario.probes[0];
    requireCheck(await service.completeJob(question.claim, { kind: 'interviewer', proposal: { action: 'ask_probe', question: probe.question, competencyId: probe.competencyId, probeId: probe.id, evidenceIds: [] }, model: 'authored', actualUsd: 0 }), 'worker_fenced');
    session = await service.getSession(ownerId, sessionId);
    await service.command(ownerId, sessionId, { requestId: randomUUID(), expectedRevision: session.revision, action: 'submit' });
    const report = await claim('coach');
    requireCheck(report.stored.frozenEvidence && report.claim.job.input.evidenceDigest === report.stored.frozenEvidence.digest && report.claim.job.input.watermark === report.stored.frozenEvidence.watermark, 'frozen_evidence_invalid');
    requireCheck(await service.completeJob(report.claim, { kind: 'coach', report: syntheticReport(), model: 'synthetic-canary-observation-only', promptVersion: 'synthetic-canary-v1', actualUsd: 0 }), 'worker_fenced');
    result.counts.reports = 1;
    service = createService();
    const completed = await service.exportSession(ownerId, sessionId), published = completed.reports[0];
    const testFact = completed.frozenEvidence?.items.find(item => item.kind === 'test');
    result.checks.frozenEvidence = Boolean(completed.frozenEvidence && completed.frozenEvidence.digest === digest(completed.frozenEvidence.items) && completed.codeFrozenSnapshotId === admitted.id && testFact && JSON.parse(testFact.content).runtimeDigest === binding.imageId && JSON.parse(testFact.content).snapshotSha256 === admitted.sha256);
    result.checks.syntheticReport = Boolean(published && published.model === 'synthetic-canary-observation-only' && published.overview.startsWith('SYNTHETIC OPERATIONS CANARY') && published.rubric.every(row => row.level === 'Not observed') && completed.usage.aiCalls === 0 && completed.usage.spentUsd === 0 && completed.jobs.every(job => job.actualUsd === 0 && job.state === 'completed' && !job.inference));
    result.checks.durableReport = Boolean(completed.lifecycle === 'completed' && completed.reports.length === 1 && published.evidenceDigest === completed.frozenEvidence?.digest && digest(published.evidence) === digest(completed.frozenEvidence?.items) && !completed.turns.some(turn => turn.role === 'learner'));
    requireCheck(result.checks.frozenEvidence && result.checks.syntheticReport && result.checks.durableReport, 'report_validation_failed');
    ensureActive();
    // Also verify through the underlying adapter, not just a retained DTO.
    requireCheck(Object.keys((await store.read()).sessions).length === 1, 'isolated_storage_invalid');
    result.status = 'passed'; result.category = 'complete';
  } catch (error) {
    result.category = error instanceof CanaryFailure ? error.category : 'policy_or_storage_failed';
    if (executionStarted && result.cleanup.execution === 'not-started') {
      result.cleanup.execution = 'unconfirmed'; result.operatorActionRequired = true;
    }
  } finally {
    controller.abort();
    if (directory) {
      if (service && ownerId && sessionId) {
        try {
          await service.deleteAccount(ownerId, { requestId: randomUUID() });
          result.checks.sessionErased = Object.keys((await new FilePracticeStore(directory).read()).sessions).length === 0;
        } catch { result.status = 'failed'; result.category = 'storage_cleanup_failed'; }
      }
      try {
        await rm(directory, { recursive: true, force: true });
        result.cleanup.storage = 'removed';
        if (result.cleanup.execution === 'unconfirmed') {
          // Preserve a content-free durable notice after erasing the fixture.
          // Never clear another worker's hold or prune/restart the daemon.
          await mkdir(directory, { mode: 0o700 });
          result.cleanupNoticePath = join(directory, 'cleanup-hold.json');
          await writeFile(result.cleanupNoticePath, JSON.stringify({ version: 1, category: 'execution_cleanup_unconfirmed', createdAt: new Date().toISOString(), action: 'Reconcile only task execution containers in the dedicated canary context before reuse. This command never clears operational holds.' }) + '\n', { mode: 0o600, flag: 'wx' });
          result.cleanup.storage = 'retained-notice';
        }
      } catch { result.cleanup.storage = 'unconfirmed'; result.operatorActionRequired = true; result.status = 'failed'; result.category = 'storage_cleanup_failed'; }
    }
    if (result.cleanup.execution === 'unconfirmed' || (directory && !result.checks.sessionErased)) result.status = 'failed';
    result.durationMs = Math.round(performance.now() - started);
  }
  return result;
}
