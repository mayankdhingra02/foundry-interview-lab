import 'server-only';
import { z } from 'zod';
import { coachOutputSchema } from '../interview-practice/evidence';
import { requireActor } from './auth';
import { handle, HttpError, privateJson, readJson } from './http';
import { getReviewService } from './review-service';

const key = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/) });
const create = key.extend({ category: z.enum(['feedback','technical']), reportId: z.string().uuid().optional(), message: z.string().min(1).max(4000), criterionIds: z.array(z.string().max(100)).max(20).optional(), inspectionConsent: z.boolean(), supportActionsConsent: z.boolean() }).strict();
const consent = key.extend({ expectedRevision: z.number().int().positive(), inspectionConsent: z.boolean(), supportActionsConsent: z.boolean() }).strict();
const inspection = key.extend({ purpose: z.string().min(1).max(300) }).strict();
const draft = key.extend({ sourceReportId: z.string().uuid(), reason: z.string().min(1).max(1000), report: coachOutputSchema }).strict();
const decision = key.extend({ decision: z.enum(['approve','reject']), note: z.string().min(1).max(2000) }).strict();
const recovery = key.extend({ action: z.enum(['retry-report','cancel-job']), jobId: z.string().uuid().optional() }).strict();
const resolution = key.extend({ resolution: z.string().min(1).max(1500) }).strict();
function parsed<T>(schema: z.ZodType<T>, value: unknown) { const result = schema.safeParse(value); if (!result.success) throw new HttpError(400, 'invalid_review_input', 'The review request does not match the expected format.'); return result.data; }

export function ownerReviews(request: Request, sessionId: string) {
  return handle(request, async () => {
    const actor = await requireActor(request), service = await getReviewService();
    if (request.method === 'GET') return privateJson({ cases: await service.listOwnerCases(actor.id, sessionId) });
    if (request.method === 'POST') return privateJson({ case: await service.createCase(actor.id, sessionId, parsed(create, await readJson(request, 8000))) }, 201);
    throw new HttpError(405, 'method_not_allowed', 'Use GET or POST for support requests.');
  });
}
export function ownerReviewConsent(request: Request, caseId: string) {
  return handle(request, async () => {
    const actor = await requireActor(request), service = await getReviewService();
    if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to change support permission.');
    return privateJson({ case: await service.setConsent(actor.id, caseId, parsed(consent, await readJson(request, 2000))) });
  });
}
export function internalReviewApi(request: Request, path: string[]) {
  return handle(request, async () => {
    const actor = await requireActor(request), service = await getReviewService();
    if (path.length === 1 && path[0] === 'access' && request.method === 'GET') return privateJson({ allowed: service.allowed(actor) });
    if (!service.allowed(actor)) throw new HttpError(403, 'staff_access_denied', 'This Foundry account does not have internal review access.');
    if (path.length === 1 && path[0] === 'deletions' && request.method === 'GET') return privateJson({ deletions: await service.deletionStatus(actor) });
    if (path[0] === 'scenarios' && path[1] && path[2] === 'preview' && path.length === 3 && request.method === 'POST') {
      const body = parsed(key.extend({ purpose: z.string().min(1).max(300), version: z.string().max(30).optional() }).strict(), await readJson(request, 2000));
      return privateJson(await service.previewScenario(actor, path[1], body));
    }
    if (path[0] !== 'reviews') throw new HttpError(404, 'not_found', 'Internal endpoint not found.');
    if (path.length === 1 && request.method === 'GET') return privateJson({ cases: await service.listCases(actor) });
    if (path.length === 2 && request.method === 'GET') return privateJson(await service.status(actor, path[1]));
    if (request.method !== 'POST') throw new HttpError(404, 'not_found', 'Internal endpoint not found.');
    if (path[1] === 'drafts' && path[2] && path.length === 4) {
      if (path[3] === 'review') return privateJson({ decision: await service.reviewDraft(actor, path[2], parsed(decision, await readJson(request, 4000))) });
      if (path[3] === 'publish') return privateJson(await service.publishDraft(actor, path[2], parsed(key.strict(), await readJson(request, 2000))));
    }
    if (path[1] && path.length === 3) {
      const id = path[1];
      if (path[2] === 'inspect') return privateJson(await service.inspect(actor, id, parsed(inspection, await readJson(request, 2000))));
      if (path[2] === 'drafts') return privateJson({ draft: await service.createDraft(actor, id, parsed(draft, await readJson(request, 64_000))) }, 201);
      if (path[2] === 'recover') return privateJson(await service.recover(actor, id, parsed(recovery, await readJson(request, 2000))));
      if (path[2] === 'resolve') return privateJson({ case: await service.resolve(actor, id, parsed(resolution, await readJson(request, 4000))) });
    }
    throw new HttpError(404, 'not_found', 'Internal endpoint not found.');
  });
}
