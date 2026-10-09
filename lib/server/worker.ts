import { randomUUID } from 'node:crypto';
import { getScenario } from '../content/scenarios';
import { assist, authoredQuestion, coach, interview, observationOnlyReport, PROMPT_VERSION, ProviderFailure } from '../ai/provider';
import { executeScenario } from '../runtime/runner';
import type { SessionService } from './session-service';
import { getService } from './application';

export async function processOneJob(service: SessionService, workerId = `worker-${randomUUID()}`): Promise<boolean> {
  const claim = await service.claimJob(workerId);
  if (!claim) return false;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    service.heartbeatJob(claim).then(valid => { if (!valid) controller.abort(); }).catch(() => controller.abort());
  }, 15_000);
  try {
    const session = await service.exportSession(claim.job.ownerId, claim.job.sessionId);
    const scenario = getScenario(session.scenarioId, session.scenarioVersion);
    const snapshot = session.snapshots.find(s => s.id === claim.job.snapshotId);
    if (!scenario || !snapshot) throw new Error('admitted_input_missing');
    session.files = structuredClone(snapshot.files);
    // Assistant inputs must refer to the admitted snapshot even if autosave advanced meanwhile.
    if (claim.job.kind === 'assistant') session.snapshots = session.snapshots.filter(s => s.sequence <= snapshot.sequence);
    const signal = controller.signal;
    const result = claim.job.kind === 'run'
      ? { kind: 'run' as const, run: await executeScenario(scenario, snapshot.files, { signal, includeProtected: true }), actualUsd: 0 }
      : claim.job.kind === 'interviewer' ? (claim.job.input.forceAuthored ? { kind: 'interviewer' as const, proposal: authoredQuestion(scenario, session), model: 'authored', actualUsd: 0 } : await interview(scenario, session, signal))
      : claim.job.kind === 'assistant' ? await assist(scenario, session, claim.job.input, signal)
      : claim.job.input.forceAuthored ? { kind: 'coach' as const, report: observationOnlyReport(scenario), model: 'authored-observation-only', promptVersion: PROMPT_VERSION, actualUsd: 0 } : await coach(scenario, session, signal);
    await service.completeJob(claim, result);
  } catch (error) {
    const definitelyNotCalled = error instanceof ProviderFailure && !error.mayHaveBilled;
    await service.failJob(claim, controller.signal.aborted
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
