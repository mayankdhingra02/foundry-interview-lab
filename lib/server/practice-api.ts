import { z } from 'zod';
import { listScenarios } from '../content/scenarios';
import { toPublicScenario } from '../interview-practice/domain';
import { requireActor } from './auth';
import { capabilities } from './config';
import { getService } from './application';
import { handle, HttpError, privateJson, readJson } from './http';
import { kickLocalWorker } from './worker';
import { exportPracticeSession } from './export';
import { streamEvents } from './event-stream';
import { handleVoiceRequest } from '../voice/api';
import { executionAdmissionOpen } from './operations';
import { ownerReviews, ownerReviewConsent } from './review-api';
import { getReviewService } from './review-service';
import { InteractionService } from './interactions';
import type { SessionMutationResult } from './session-service';
import { buildProgression } from '../interview-practice/progression';
import { admittedScenarios } from './rollout';

const mutation = z.object({ requestId: z.string().min(8).max(128), expectedRevision: z.number().int().nonnegative() });
const key = z.object({ requestId: z.string().min(8).max(128) });
const creation = z.object({ scenarioId: z.string().max(100), version: z.string().max(30).optional(), mode: z.enum(['practice', 'simulation']).optional(), requestId: z.string().min(8).max(128), role: z.string().max(120).optional(), level: z.string().max(100).optional(), skills: z.array(z.string().max(100)).max(20).optional(), targetMinutes: z.number().int().min(5).max(180).optional(), aiHelp: z.boolean().optional(), accommodations: z.array(z.string().max(200)).max(10).optional() });

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'The request does not match the expected format.');
  return result.data;
}

export async function practiceApi(request: Request, path: string[]) {
  return handle(request, async () => {
    const method = request.method;
    if (path.length === 1 && path[0] === 'capabilities' && method === 'GET') return privateJson({ capabilities: capabilities() });
    if (path.length === 1 && path[0] === 'scenarios' && method === 'GET') return privateJson({ scenarios: admittedScenarios(listScenarios()).map(toPublicScenario), capabilities: capabilities() });
    const actor = await requireActor(request), service = await getService();
    if (path[0] === 'reviews' && path[1] && path[2] === 'consent' && path.length === 3) return ownerReviewConsent(request, path[1]);
    if (path.length === 1 && path[0] === 'progress' && method === 'GET') {
      const sessions = await service.listSessions(actor.id);
      const catalog = listScenarios().map(toPublicScenario);
      const goals = parsed(z.array(z.string().min(1).max(100)).max(20), new URL(request.url).searchParams.getAll('competency'));
      const known = new Set([...catalog, ...sessions.map(session => session.scenario)].flatMap(scenario => scenario.rubric.map(criterion => criterion.id)));
      if (goals.some(id => !known.has(id))) throw new HttpError(400, 'unknown_competency', 'Choose authored criteria from the catalog or your saved attempts.');
      return privateJson(buildProgression(sessions, admittedScenarios(catalog), { selectedCompetencies: goals }));
    }
    if (path[0] === 'sessions' && path.length === 1) {
      if (method === 'GET') return privateJson({ sessions: await service.listSessions(actor.id) });
      if (method === 'POST') {
        const result = await service.createSession(actor.id, parsed(creation, await readJson(request, 5000)));
        return privateJson({ ...result, capabilities: capabilities() }, 201);
      }
    }
    if (path[0] === 'jobs' && path[1]) {
      if (method === 'GET' && path.length === 2) return privateJson({ job: await service.getJob(actor.id, path[1]) });
      if (method === 'POST' && path[2] === 'cancel' && path.length === 3) return privateJson({ job: await service.cancelJob(actor.id, path[1], parsed(key, await readJson(request, 2000))) });
    }
    if (path[0] !== 'sessions' || !path[1]) throw new HttpError(404, 'not_found', 'Endpoint not found.');
    const id = path[1], operation = path[2];
    if (path.length === 2 && method === 'GET') {
      const session = await service.getSession(actor.id, id); kickLocalWorker();
      return privateJson({ session, scenario: session.scenario, capabilities: capabilities() });
    }
    if (path.length === 2 && method === 'DELETE') return privateJson(await service.deleteSession(actor.id, id, parsed(key, await readJson(request, 2000))));
    if (operation === 'voice' && path.length === 4 && ['transcribe', 'speak'].includes(path[3])) return handleVoiceRequest(request, actor.id, id, path[3] as 'transcribe' | 'speak');
    if (path.length !== 3) throw new HttpError(404, 'not_found', 'Endpoint not found.');
    if (operation === 'reviews') return ownerReviews(request, id);
    if (operation === 'events' && method === 'GET') {
      const after = Number(new URL(request.url).searchParams.get('after') || request.headers.get('last-event-id') || 0);
      if (request.headers.get('accept')?.includes('text/event-stream')) return streamEvents(request, service, actor.id, id, after);
      return privateJson({ events: await service.events(actor.id, id, after) });
    }
    if (operation === 'export' && method === 'GET') {
      const session = exportPracticeSession(await service.exportSession(actor.id, id));
      const reviews = await (await getReviewService()).exportOwner(actor.id, id);
      return privateJson({ session, reviews }, 200, { 'Content-Disposition': `attachment; filename="practice-${id}.json"` });
    }
    if (!['POST', 'PUT'].includes(method)) throw new HttpError(404, 'not_found', 'Endpoint not found.');
    const body = await readJson(request, operation === 'workspace' ? 300_000 : operation === 'interaction' ? 2000 : 20_000);
    let result: SessionMutationResult;
    if (method === 'PUT' && operation === 'workspace') result = await service.saveWorkspace(actor.id, id, parsed(mutation.extend({ files: z.record(z.string().max(64_000)) }), body));
    else if (method === 'POST' && operation === 'commands') result = await service.command(actor.id, id, parsed(mutation.extend({ action: z.enum(['advance', 'pause', 'resume', 'finish', 'submit']) }), body));
    else if (method === 'POST' && operation === 'turns') result = await service.commitTurn(actor.id, id, parsed(mutation.extend({ text: z.string().min(1).max(6000), source: z.enum(['typed', 'transcribed', 'corrected']).optional(), replyTo: z.string().optional() }), body));
    else if (method === 'POST' && operation === 'interaction') result = await new InteractionService(service.store).interact(actor.id, id, parsed(mutation.extend({ action: z.enum(['working', 'repeat', 'clarify']), topic: z.enum(['requirements', 'assistance', 'timing']).optional() }).strict(), body));
    else if (method === 'POST' && operation === 'runs') {
      if (!capabilities().runner || !await executionAdmissionOpen()) throw new HttpError(503, 'runner_unavailable', 'Execution is unavailable or on an operational hold. Your work is saved.');
      result = await service.requestRun(actor.id, id, parsed(mutation, body));
    } else if (method === 'POST' && operation === 'assistant') {
      if (!capabilities().assistant) throw new HttpError(503, 'assistant_unavailable', 'AI assistance is not configured.');
      result = await service.requestAssistant(actor.id, id, parsed(mutation.extend({ mode: z.enum(['ask', 'plan', 'edit']), message: z.string().max(3000).optional(), prompt: z.string().max(3000).optional() }), body));
    } else if (method === 'POST' && operation === 'edit-decisions') result = await service.decideEdit(actor.id, id, parsed(mutation.extend({ proposalId: z.string(), decision: z.enum(['accept', 'reject']) }), body));
    else if (method === 'POST' && operation === 'undo-edit') result = await service.undoEdit(actor.id, id, parsed(mutation.extend({ proposalId: z.string().uuid() }).strict(), body));
    else if (method === 'POST' && operation === 'hints') result = await service.revealHint(actor.id, id, parsed(mutation, body));
    else if (method === 'POST' && operation === 'drills') result = await service.completeDrill(actor.id, id, parsed(mutation.extend({ drillId: z.string() }), body));
    else if (method === 'POST' && operation === 'reports') result = await service.retryReport(actor.id, id, parsed(key, body));
    else throw new HttpError(404, 'not_found', 'Endpoint not found.');
    kickLocalWorker();
    return privateJson({ ...result, capabilities: capabilities() }, result.job && ['queued', 'running'].includes(result.job.state) ? 202 : 200);
  });
}
