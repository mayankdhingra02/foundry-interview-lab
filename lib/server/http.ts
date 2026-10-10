import { applicationOrigin } from './config';
import { assertSameOrigin, handleWithOrigin } from './http-core';

// Keep one error class/envelope across standalone and host dispatchers.
export { HttpError, privateJson, readJson, errorResponse } from './http-core';
export function sameOrigin(request: Request) { return assertSameOrigin(request, applicationOrigin); }
export function handle(request: Request, operation: () => Promise<Response>) {
  return handleWithOrigin(request, operation, applicationOrigin);
}
