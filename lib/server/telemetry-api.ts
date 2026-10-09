import 'server-only';
import { browserObservation } from '../interview-practice/telemetry';
import { requireActor } from './auth';
import { getService } from './application';
import { handle, HttpError, privateJson, readJson } from './http';
import { browserObservationGate, emitTelemetry, telemetryConfig } from './telemetry';

export async function telemetryApi(request: Request, sessionId: string) {
  return handle(request, async () => {
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST for observations.');
    const actor = await requireActor(request);
    if (!telemetryConfig()) return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
    const result = browserObservation.safeParse(await readJson(request, 600));
    if (!result.success) throw new HttpError(400, 'invalid_observation', 'The observation does not match the bounded schema.');
    const input = result.data, session = await (await getService()).getSession(actor.id, sessionId);
    if (input.event === 'feedback.opened' && !session.reports.some(report => report.id === input.reportId)) throw new HttpError(404, 'not_found', 'Report not found.');
    if (input.event === 'latency.measured') {
      if (['job.queue', 'sandbox.provision'].includes(input.metric)) throw new HttpError(400, 'invalid_observation', 'That metric is recorded by the server.');
      if (input.jobId) {
        const job = session.jobs.find(job => job.id === input.jobId);
        const kind = input.metric === 'run.result' ? 'run' : input.metric === 'report.ready' ? 'coach' : input.metric === 'text.turn' ? 'interviewer' : null;
        if (!job || !kind || job.kind !== kind) throw new HttpError(404, 'not_found', 'Operation not found.');
      }
    }
    const admission = browserObservationGate.admit(actor.id, input.eventId);
    if (admission === 'limited') throw new HttpError(429, 'observation_limit', 'Observation limit reached.');
    if (admission === 'duplicate') return privateJson({ accepted: true, duplicate: true }, 202);
    const observation = input.event === 'feedback.opened'
      ? { event: 'feedback.opened' as const, reportKind: session.reports.find(report => report.id === input.reportId)!.correction ? 'corrected' as const : 'original' as const }
      : { event: 'latency.measured' as const, metric: input.metric, durationMs: input.durationMs, outcome: input.outcome };
    emitTelemetry(actor.id, session.id, input.eventId, observation, { origin: 'browser-unverified', ...(input.event === 'latency.measured' && input.jobId ? { jobId: input.jobId } : {}) });
    return privateJson({ accepted: true }, 202);
  });
}
