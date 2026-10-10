import { randomUUID } from 'node:crypto';
import { getScenario } from '../content/scenarios';
import { assist, authoredQuestion, coach, interview, observationOnlyReport, PROMPT_VERSION, ProviderFailure } from '../ai/provider';
import { executeScenario, runnerHealth } from '../runtime/runner';
import type { RunExecution, Scenario } from '../interview-practice/types';
import { blockExecutionAdmission, executionAdmissionOpen } from './operations';
import type { SessionService } from './session-service';
import { getService } from './application';
import { digest } from '../interview-practice/domain';
import { parseRuntimeBinding, type RuntimeBinding } from '../runtime/binding';
import { admittedRunSuite } from '../interview-practice/learner-checks';
import type { RunSelection } from '../interview-practice/check-policy';
import { emitTelemetry, telemetryConfig } from './telemetry';
import { isUnseenFocusedRetest } from '../interview-practice/telemetry-learning';
import type { JobClaim } from '../interview-practice/types';
import { compatibleInferenceBinding } from '../ai/binding';

class AdmittedInputMismatch extends Error {}
class MissingRuntimeBinding extends Error {}
class MissingInferenceBinding extends Error {}

async function executeAdmittedSnapshot(scenario: Scenario, files: Record<string, string>, signal: AbortSignal, runtimeBinding: RuntimeBinding, selection?: RunSelection, claim?: JobClaim): Promise<RunExecution> {
  if (!await executionAdmissionOpen()) return {
    status: 'infrastructure_error', command: 'execution admission', stdout: '',
    stderr: 'Execution is on an operational hold. Your work is saved; no code was executed.',
    exitCode: null, tests: [], durationMs: 0,
  };
  try { return await executeScenario(scenario, files, { signal, includeProtected: true, runtimeBinding, ...(selection === 'learner' ? { selection } : {}), ...(claim && telemetryConfig() ? { onProvision: (durationMs: number, index: number) => { emitTelemetry(claim.job.ownerId, claim.job.sessionId, `${claim.job.id}:provision:${index}`, { event: 'latency.measured', metric: 'sandbox.provision', durationMs, outcome: 'acknowledged', jobKind: 'run' }, { jobId: claim.job.id }); } } : {}) }); }
  finally {
    if (runnerHealth().blockedReason !== null) await blockExecutionAdmission().catch(() => {
      // Preserve genuine execution observations. Admission also fails closed when storage is unavailable.
      console.error(JSON.stringify({ event: 'worker.execution-hold.failed', category: 'operations_storage' }));
    });
  }
}

export async function processOneJob(service: SessionService, workerId = `worker-${randomUUID()}`): Promise<boolean> {
  const claim = await service.claimJob(workerId);
  if (!claim) return false;
  emitTelemetry(claim.job.ownerId, claim.job.sessionId, `${claim.job.id}:queue:${claim.fencingToken}`, { event: 'latency.measured', metric: 'job.queue', durationMs: Date.now() - Date.parse(claim.job.createdAt), outcome: 'acknowledged', jobKind: claim.job.kind }, { jobId: claim.job.id });
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    service.heartbeatJob(claim).then(valid => { if (!valid) controller.abort(); }).catch(() => controller.abort());
  }, 15_000);
  let externalWorkStarted = false;
  try {
    const session = await service.exportSession(claim.job.ownerId, claim.job.sessionId);
    const scenario = getScenario(session.scenarioId, session.scenarioVersion);
    const snapshot = session.snapshots.find(s => s.id === claim.job.snapshotId);
    const storedJob = session.jobs.find(job => job.id === claim.job.id);
    // Verify the exact admitted private package and immutable snapshot before
    // execution or inference. Completion validation alone is too late to avoid
    // spending on a replaced same-version package or executing changed checks.
    if (!scenario || !snapshot || !storedJob || storedJob.kind !== claim.job.kind || storedJob.snapshotId !== claim.job.snapshotId
      || storedJob.fingerprint !== claim.job.fingerprint || storedJob.reservedUsd !== claim.job.reservedUsd
      || storedJob.claimToken !== claim.claimToken || storedJob.fencingToken !== claim.fencingToken || storedJob.workerId !== claim.workerId || storedJob.state !== 'running' || storedJob.cancellationRequested
      || digest(storedJob.input) !== storedJob.fingerprint || digest(scenario) !== session.scenarioDigest || digest(snapshot.files) !== snapshot.sha256
      || digest(claim.job.input) !== claim.job.fingerprint
      || (claim.job.kind === 'run' && digest(claim.job.input.runtime) !== digest(scenario.runtime))) {
      throw new AdmittedInputMismatch();
    }
    if (claim.job.kind === 'run') {
      try { admittedRunSuite(scenario, snapshot.files, claim.job.input); } catch { throw new AdmittedInputMismatch(); }
    }
    const runtimeBinding = claim.job.kind === 'run' ? parseRuntimeBinding(claim.job.input.runtimeBinding,scenario.runtime.image) : null;
    if (claim.job.kind === 'run' && !runtimeBinding) throw new MissingRuntimeBinding();
    const inferenceBinding = storedJob.kind === 'run' ? null : compatibleInferenceBinding(storedJob.input.inferenceBinding, storedJob.kind);
    if (claim.job.kind === 'assistant' && (!inferenceBinding || claim.job.input.forceAuthored || claim.job.reservedUsd + 1e-9 < inferenceBinding.reserveUsd)) throw new MissingInferenceBinding();
    const authored = claim.job.input.forceAuthored || !inferenceBinding || claim.job.reservedUsd + 1e-9 < inferenceBinding.reserveUsd;
    session.files = structuredClone(snapshot.files);
    // Assistant inputs must refer to the admitted snapshot even if autosave advanced meanwhile.
    if (claim.job.kind === 'assistant') session.snapshots = session.snapshots.filter(s => s.sequence <= snapshot.sequence);
    const signal = controller.signal;
    externalWorkStarted = true;
    const result = claim.job.kind === 'run'
      ? { kind: 'run' as const, run: await executeAdmittedSnapshot(scenario, snapshot.files, signal, runtimeBinding!, claim.job.input.selection === 'learner' ? 'learner' : undefined, claim), actualUsd: 0 }
      : claim.job.kind === 'interviewer' ? (authored ? { kind: 'interviewer' as const, proposal: authoredQuestion(scenario, session), model: 'authored', actualUsd: 0 } : await interview(scenario, session, signal, inferenceBinding!))
      : claim.job.kind === 'assistant' ? await assist(scenario, session, claim.job.input, signal, inferenceBinding!)
      : authored ? { kind: 'coach' as const, report: observationOnlyReport(scenario), model: 'authored-observation-only', promptVersion: PROMPT_VERSION, actualUsd: 0 } : await coach(scenario, session, signal, inferenceBinding!);
    const accepted = await service.completeJob(claim, result);
    if (accepted) {
      const metric = claim.job.kind === 'run' ? 'run.result' : claim.job.kind === 'coach' ? 'report.ready' : claim.job.kind === 'interviewer' ? 'text.turn' : null;
      if (metric) emitTelemetry(claim.job.ownerId, claim.job.sessionId, `${claim.job.id}:result:${claim.fencingToken}`, { event: 'latency.measured', metric, durationMs: Date.now() - Date.parse(claim.job.createdAt), outcome: result.kind === 'run' && result.run.status !== 'completed' ? 'failed' : 'acknowledged', jobKind: claim.job.kind }, { jobId: claim.job.id });
      if (claim.job.kind === 'coach' && telemetryConfig()) {
        try {
          const history = await service.listSessions(claim.job.ownerId), completed = history.find(row => row.id === claim.job.sessionId);
          if (completed && isUnseenFocusedRetest(completed, history)) emitTelemetry(claim.job.ownerId, completed.id, `${claim.job.id}:unseen-retest`, { event: 'unseen-retest.completed', priorFocusedDrill: true, exposureBasis: 'saved-history-only' }, { jobId: claim.job.id });
        } catch { /* Optional measurement reads cannot invalidate a completed report. */ }
      }
    }
  } catch (error) {
    const definitelyNotCalled = !externalWorkStarted || error instanceof ProviderFailure && !error.mayHaveBilled;
    const failed = await service.failJob(claim, error instanceof MissingInferenceBinding
      ? 'This queued AI operation has no supported admitted inference policy. No inference started. Explicitly request new assistance when the service is configured.'
      : error instanceof MissingRuntimeBinding
      ? 'This queued run predates immutable runtime admission or has an invalid binding. No execution started. Configure the reviewed image and explicitly request a new run.'
      : error instanceof AdmittedInputMismatch
      ? 'The admitted scenario or snapshot no longer matches its saved identity. No execution or inference started. Restore the original package before retrying.'
      : error instanceof ProviderFailure && error.category === 'privacy_input'
      ? 'Remove credential-like values from the workspace before requesting a complete AI file edit. Your files are saved and were not sent to the model.'
      : controller.signal.aborted
      ? 'Operation interrupted or cancelled. The acknowledged attempt remains available.'
      : `${claim.job.kind === 'run' ? 'Code execution' : 'AI operation'} could not finish. Retry when the service is available.`, definitelyNotCalled ? 0 : error instanceof ProviderFailure ? error.inference?.usd : undefined, error instanceof ProviderFailure ? error.inference : undefined);
    const metric = claim.job.kind === 'run' ? 'run.result' : claim.job.kind === 'coach' ? 'report.ready' : claim.job.kind === 'interviewer' ? 'text.turn' : null;
    if (failed && metric) emitTelemetry(claim.job.ownerId, claim.job.sessionId, `${claim.job.id}:result:${claim.fencingToken}`, { event: 'latency.measured', metric, durationMs: Date.now() - Date.parse(claim.job.createdAt), outcome: controller.signal.aborted ? 'cancelled' : 'failed', jobKind: claim.job.kind }, { jobId: claim.job.id });
  } finally { clearInterval(heartbeat); }
  return true;
}

let localDrain: Promise<void> | undefined;
export function kickLocalWorker() {
  if (process.env.NODE_ENV === 'production' || localDrain) return;
  localDrain = (async () => {
    const service = await getService();
    while (await processOneJob(service, `local-${process.pid}`)) { /* Lease-based durable work. */ }
  })().catch(() => { console.error(JSON.stringify({ event: 'local-worker.failed' })); }).finally(() => { localDrain = undefined; });
}
