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

class AdmittedInputMismatch extends Error {}
class MissingRuntimeBinding extends Error {}

async function executeAdmittedSnapshot(scenario: Scenario, files: Record<string, string>, signal: AbortSignal, runtimeBinding: RuntimeBinding, selection?: RunSelection): Promise<RunExecution> {
  if (!await executionAdmissionOpen()) return {
    status: 'infrastructure_error', command: 'execution admission', stdout: '',
    stderr: 'Execution is on an operational hold. Your work is saved; no code was executed.',
    exitCode: null, tests: [], durationMs: 0,
  };
  try { return await executeScenario(scenario, files, { signal, includeProtected: true, runtimeBinding, ...(selection === 'learner' ? { selection } : {}) }); }
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
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    service.heartbeatJob(claim).then(valid => { if (!valid) controller.abort(); }).catch(() => controller.abort());
  }, 15_000);
  let externalWorkStarted = false;
  try {
    const session = await service.exportSession(claim.job.ownerId, claim.job.sessionId);
    const scenario = getScenario(session.scenarioId, session.scenarioVersion);
    const snapshot = session.snapshots.find(s => s.id === claim.job.snapshotId);
    // Verify the exact admitted private package and immutable snapshot before
    // execution or inference. Completion validation alone is too late to avoid
    // spending on a replaced same-version package or executing changed checks.
    if (!scenario || !snapshot || digest(scenario) !== session.scenarioDigest || digest(snapshot.files) !== snapshot.sha256
      || (claim.job.kind === 'run' && (digest(claim.job.input) !== claim.job.fingerprint || digest(claim.job.input.runtime) !== digest(scenario.runtime)))) {
      throw new AdmittedInputMismatch();
    }
    if (claim.job.kind === 'run') {
      try { admittedRunSuite(scenario, snapshot.files, claim.job.input); } catch { throw new AdmittedInputMismatch(); }
    }
    const runtimeBinding = claim.job.kind === 'run' ? parseRuntimeBinding(claim.job.input.runtimeBinding,scenario.runtime.image) : null;
    if (claim.job.kind === 'run' && !runtimeBinding) throw new MissingRuntimeBinding();
    session.files = structuredClone(snapshot.files);
    // Assistant inputs must refer to the admitted snapshot even if autosave advanced meanwhile.
    if (claim.job.kind === 'assistant') session.snapshots = session.snapshots.filter(s => s.sequence <= snapshot.sequence);
    const signal = controller.signal;
    externalWorkStarted = true;
    const result = claim.job.kind === 'run'
      ? { kind: 'run' as const, run: await executeAdmittedSnapshot(scenario, snapshot.files, signal, runtimeBinding!, claim.job.input.selection === 'learner' ? 'learner' : undefined), actualUsd: 0 }
      : claim.job.kind === 'interviewer' ? (claim.job.input.forceAuthored ? { kind: 'interviewer' as const, proposal: authoredQuestion(scenario, session), model: 'authored', actualUsd: 0 } : await interview(scenario, session, signal))
      : claim.job.kind === 'assistant' ? await assist(scenario, session, claim.job.input, signal)
      : claim.job.input.forceAuthored ? { kind: 'coach' as const, report: observationOnlyReport(scenario), model: 'authored-observation-only', promptVersion: PROMPT_VERSION, actualUsd: 0 } : await coach(scenario, session, signal);
    await service.completeJob(claim, result);
  } catch (error) {
    const definitelyNotCalled = !externalWorkStarted || error instanceof ProviderFailure && !error.mayHaveBilled;
    await service.failJob(claim, error instanceof MissingRuntimeBinding
      ? 'This queued run predates immutable runtime admission or has an invalid binding. No execution started. Configure the reviewed image and explicitly request a new run.'
      : error instanceof AdmittedInputMismatch
      ? 'The admitted scenario or snapshot no longer matches its saved identity. No execution or inference started. Restore the original package before retrying.'
      : error instanceof ProviderFailure && error.category === 'privacy_input'
      ? 'Remove credential-like values from the workspace before requesting a complete AI file edit. Your files are saved and were not sent to the model.'
      : controller.signal.aborted
      ? 'Operation interrupted or cancelled. The acknowledged attempt remains available.'
      : `${claim.job.kind === 'run' ? 'Code execution' : 'AI operation'} could not finish. Retry when the service is available.`, definitelyNotCalled ? 0 : error instanceof ProviderFailure ? error.inference?.usd : undefined, error instanceof ProviderFailure ? error.inference : undefined);
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
