import 'server-only';
import { requireActor } from './auth';
import { handle, HttpError, privateJson } from './http';
import { reviewAdminAllowed } from './review-service';
import { configuredRepositoryEvaluations } from './evaluation-library';

export function internalEvaluationApi(request: Request, path: string[]) {
  return handle(request, async () => {
    const actor = await requireActor(request);
    if (!reviewAdminAllowed(actor)) throw new HttpError(403, 'staff_access_denied', 'This Foundry account does not have internal review access.');
    if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'Evaluation examples are read-only.');
    if (new URL(request.url).search) throw new HttpError(400, 'invalid_evaluation_source', 'Evaluation sources are fixed repository fixtures.');
    if (!path.length) return privateJson((await configuredRepositoryEvaluations()).catalog);
    if (path.length === 1 && /^[a-z0-9-]{1,100}$/.test(path[0])) {
      const example = (await configuredRepositoryEvaluations()).details.find(row => row.id === path[0]);
      if (!example) throw new HttpError(404, 'not_found', 'Evaluation example not found.');
      return privateJson({ example });
    }
    throw new HttpError(404, 'not_found', 'Evaluation example not found.');
  });
}
