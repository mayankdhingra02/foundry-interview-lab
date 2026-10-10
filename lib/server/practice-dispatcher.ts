import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { withScenarioPreparation } from '../content/preparation';
import { buildProgression, type ProgressionResult } from '../interview-practice/progression';
import { practiceConditionsSchema } from '../interview-practice/timing';
import type { Scenario, SessionView } from '../interview-practice/types';
import type { TelemetryObservation } from '../interview-practice/telemetry';
import { handleWithOrigin, HttpError, privateJson, readJson } from './http-core';
import { exportPracticeSession } from './export';
import { streamEvents } from './event-stream';
import type { InteractionInput, InteractionResult } from './interactions';
import type { SessionMutationResult, SessionService } from './session-service';
import type { ReviewService } from './review-service';

export type VerifiedPracticeActor = Readonly<{ id: string }>;
export type PracticeCapabilities = Readonly<{
  ai: boolean; coaching: boolean; runner: boolean; voice: boolean; billing: boolean; accounts: boolean;
  assistant: boolean; interviewer: boolean; telemetry?: boolean; authMode?: string; details?: Readonly<Record<string, string>>;
}>;

/** Trusted server composition only. Never construct these dependencies from a request. */
export interface PracticeApiHost {
  resolveActor(request: Request): Promise<VerifiedPracticeActor | null>;
  getService(): Promise<SessionService>;
  capabilities(): PracticeCapabilities;
  origin(): string;
  listScenarios(): Scenario[];
  admittedScenarios<T extends { id: string }>(catalog: T[]): T[];
  withNavigation(result: ProgressionResult): ProgressionResult;
  executionAdmissionOpen(): Promise<boolean>;
  interact(service: SessionService, ownerId: string, sessionId: string, input: InteractionInput): Promise<InteractionResult>;
  /** Best effort signal after acknowledged state; it must not be the durable queue. */
  notifyWorkAvailable(): void | Promise<void>;
  // Owner IDs below come only from resolveActor. Delegates retain deterministic ownership/consent checks.
  ownerReviews(request: Request, ownerId: string, sessionId: string): Promise<Response>;
  ownerReviewConsent(request: Request, ownerId: string, caseId: string): Promise<Response>;
  exportReviews(ownerId: string, sessionId: string): ReturnType<ReviewService['exportOwner']>;
  handleVoiceRequest(request: Request, ownerId: string, sessionId: string, operation: 'transcribe' | 'speak'): Promise<Response>;
  emitMutationTelemetry(ownerId: string, session: SessionView, requestId: string): void;
  emitTelemetry(ownerId: string, sessionId: string, logicalId: string, observation: TelemetryObservation): unknown;
}

const mutation = z.object({ requestId: z.string().min(8).max(128), expectedRevision: z.number().int().nonnegative() });
const key = z.object({ requestId: z.string().min(8).max(128) });
const creation = z.object({ scenarioId: z.string().max(100), version: z.string().max(30).optional(), mode: z.enum(['practice', 'simulation']).optional(), requestId: z.string().min(8).max(128), role: z.string().max(120).optional(), level: z.string().max(100).optional(), skills: z.array(z.string().max(100)).max(20).optional(), targetMinutes: z.number().int().min(5).max(180).optional(), aiHelp: z.boolean().optional(), voice: z.boolean().optional(), accommodations: z.array(z.string().max(200)).max(10).optional(), practiceConditions: practiceConditionsSchema.optional() });

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, 'invalid_input', 'The request does not match the expected format.');
  return result.data;
}

/** Host identity must already be provider-verified; client-selected owners are never accepted. */
export function createPracticeApi(host: PracticeApiHost) {
  const observe = (operation: () => unknown) => {
    try { void Promise.resolve(operation()).catch(() => undefined); }
    catch { /* Optional measurement cannot invalidate acknowledged work. */ }
  };
  // Never hold a durable acknowledgement open for a best-effort wake-up signal.
  const notify = () => observe(() => host.notifyWorkAvailable());
  return async function dispatchPracticeRequest(request: Request, path: string[]) {
    return handleWithOrigin(request, async () => {
      const method = request.method;
      if (path.length === 1 && path[0] === 'capabilities' && method === 'GET') return privateJson({ capabilities: host.capabilities() });
      if (path.length === 1 && path[0] === 'scenarios' && method === 'GET') return privateJson({ scenarios: host.admittedScenarios(host.listScenarios()).map(withScenarioPreparation), capabilities: host.capabilities() });
      const actor = await host.resolveActor(request);
      if (!actor) throw new HttpError(401, 'authentication_required', 'Sign in to access your practice history.');
      if (typeof actor.id !== 'string' || !actor.id || actor.id.length > 200) throw new HttpError(503, 'identity_unconfigured', 'Verified account access is unavailable.');
      const service = await host.getService();
      if (path[0] === 'reviews' && path[1] && path[2] === 'consent' && path.length === 3) return host.ownerReviewConsent(request, actor.id, path[1]);
      if (path.length === 1 && path[0] === 'progress' && method === 'GET') {
        const sessions = await service.listSessions(actor.id);
        const catalog = host.listScenarios().map(withScenarioPreparation);
        const goals = parsed(z.array(z.string().min(1).max(100)).max(20), new URL(request.url).searchParams.getAll('competency'));
        const known = new Set([...catalog, ...sessions.map(session => session.scenario)].flatMap(scenario => scenario.rubric.map(criterion => criterion.id)));
        if (goals.some(id => !known.has(id))) throw new HttpError(400, 'unknown_competency', 'Choose authored criteria from the catalog or your saved attempts.');
        return privateJson(host.withNavigation(buildProgression(sessions, host.admittedScenarios(catalog), { selectedCompetencies: goals })));
      }
      if (path[0] === 'sessions' && path.length === 1) {
        if (method === 'GET') {
          const intendedOwner = request.headers.get('x-practice-owner');
          if (intendedOwner !== null && intendedOwner !== actor.id) throw new HttpError(409, 'owner_changed', 'Your account changed. Review the signed-in account before deleting practice data.');
          return privateJson({ sessions: await service.listSessions(actor.id) });
        }
        if (method === 'POST') {
          const input = parsed(creation, await readJson(request, 5000));
          const result = await service.createSession(actor.id, input);
          observe(() => host.emitMutationTelemetry(actor.id, result.session, input.requestId));
          return privateJson({ ...result, capabilities: host.capabilities() }, 201);
        }
      }
      if (path[0] === 'jobs' && path[1]) {
        if (method === 'GET' && path.length === 2) return privateJson({ job: await service.getJob(actor.id, path[1]) });
        if (method === 'POST' && path[2] === 'cancel' && path.length === 3) return privateJson({ job: await service.cancelJob(actor.id, path[1], parsed(key, await readJson(request, 2000))) });
      }
      if (path[0] !== 'sessions' || !path[1]) throw new HttpError(404, 'not_found', 'Endpoint not found.');
      const id = path[1], operation = path[2];
      if (path.length === 2 && method === 'GET') {
        const session = await service.getSession(actor.id, id); notify();
        return privateJson({ session, scenario: session.scenario, capabilities: host.capabilities() });
      }
      if (path.length === 2 && method === 'DELETE') {
        const intendedOwner = request.headers.get('x-practice-owner');
        if (intendedOwner !== null && intendedOwner !== actor.id) throw new HttpError(409, 'owner_changed', 'Your account changed. Review the signed-in account before deleting practice data.');
        return privateJson(await service.deleteSession(actor.id, id, parsed(key, await readJson(request, 2000))));
      }
      if (operation === 'voice' && path.length === 4 && ['transcribe', 'speak'].includes(path[3])) return host.handleVoiceRequest(request, actor.id, id, path[3] as 'transcribe' | 'speak');
      if (path.length !== 3) throw new HttpError(404, 'not_found', 'Endpoint not found.');
      if (operation === 'reviews') return host.ownerReviews(request, actor.id, id);
      if (operation === 'events' && method === 'GET') {
        const after = Number(new URL(request.url).searchParams.get('after') || request.headers.get('last-event-id') || 0);
        if (request.headers.get('accept')?.includes('text/event-stream')) return streamEvents(request, service, actor.id, id, after);
        return privateJson({ events: await service.events(actor.id, id, after) });
      }
      if (operation === 'export' && method === 'GET') {
        const session = exportPracticeSession(await service.exportSession(actor.id, id));
        const reviews = await host.exportReviews(actor.id, id);
        return privateJson({ session, reviews }, 200, { 'Content-Disposition': `attachment; filename="practice-${id}.json"` });
      }
      if (!['POST', 'PUT'].includes(method)) throw new HttpError(404, 'not_found', 'Endpoint not found.');
      const operationStarted = performance.now();
      const body = await readJson(request, operation === 'workspace' ? 300_000 : ['interaction', 'timing'].includes(operation) ? 2000 : 20_000);
      let result: SessionMutationResult;
      if (method === 'PUT' && operation === 'workspace') result = await service.saveWorkspace(actor.id, id, parsed(mutation.extend({ files: z.record(z.string().max(64_000)) }), body));
      else if (method === 'POST' && operation === 'commands') result = await service.command(actor.id, id, parsed(mutation.extend({ action: z.enum(['advance', 'pause', 'resume', 'finish', 'submit']) }), body));
      else if (method === 'POST' && operation === 'timing') result = await service.extendTiming(actor.id, id, parsed(mutation.extend({ additionalMinutes: z.union([z.literal(15), z.literal(30)]) }).strict(), body));
      else if (method === 'POST' && operation === 'turns') result = await service.commitTurn(actor.id, id, parsed(mutation.extend({ text: z.string().min(1).max(6000), source: z.enum(['typed', 'transcribed', 'corrected']).optional(), replyTo: z.string().optional() }), body));
      else if (method === 'POST' && operation === 'interaction') result = await host.interact(service, actor.id, id, parsed(mutation.extend({ action: z.enum(['working', 'repeat', 'clarify']), topic: z.enum(['requirements', 'assistance', 'timing']).optional() }).strict(), body));
      else if (method === 'POST' && operation === 'runs') {
        const input = parsed(mutation.extend({ selection: z.enum(['authored', 'learner']).optional() }).strict(), body);
        // Operational reads stay outside the transaction. Only fresh work invokes
        // this captured decision; acknowledged retries retain their original result.
        let available = false;
        try { available = host.capabilities().runner && await host.executionAdmissionOpen(); } catch { /* Fail closed for new work. */ }
        result = await service.requestRun(actor.id, id, input, () => {
          if (!available) throw new HttpError(503, 'runner_unavailable', 'Execution is unavailable or on an operational hold. Your work is saved.');
        });
      } else if (method === 'POST' && operation === 'assistant') {
        const input = parsed(mutation.extend({ mode: z.enum(['ask', 'plan', 'edit']), message: z.string().max(3000).optional(), prompt: z.string().max(3000).optional() }), body);
        let available = false;
        try { available = host.capabilities().assistant; } catch { /* Fail closed for new work. */ }
        result = await service.requestAssistant(actor.id, id, input, () => {
          if (!available) throw new HttpError(503, 'assistant_unavailable', 'AI assistance is not configured.');
        });
      } else if (method === 'POST' && operation === 'edit-decisions') result = await service.decideEdit(actor.id, id, parsed(mutation.extend({ proposalId: z.string(), decision: z.enum(['accept', 'reject']) }), body));
      else if (method === 'POST' && operation === 'undo-edit') result = await service.undoEdit(actor.id, id, parsed(mutation.extend({ proposalId: z.string().uuid() }).strict(), body));
      else if (method === 'POST' && operation === 'hints') result = await service.revealHint(actor.id, id, parsed(mutation, body));
      else if (method === 'POST' && operation === 'drills') result = await service.completeDrill(actor.id, id, parsed(mutation.extend({ drillId: z.string() }), body));
      else if (method === 'POST' && operation === 'reports') result = await service.retryReport(actor.id, id, parsed(key, body));
      else throw new HttpError(404, 'not_found', 'Endpoint not found.');
      if (typeof body.requestId === 'string') { const requestId = body.requestId; observe(() => host.emitMutationTelemetry(actor.id, result.session, requestId)); }
      if (operation === 'workspace') observe(() => host.emitTelemetry(actor.id, result.session.id, randomUUID(), { event: 'latency.measured', metric: 'workspace.save', durationMs: performance.now() - operationStarted, outcome: 'acknowledged' }));
      notify();
      return privateJson({ ...result, capabilities: host.capabilities() }, result.job && ['queued', 'running'].includes(result.job.state) ? 202 : 200);
    }, () => host.origin());
  };
}
