import { applicationOrigin } from './config';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export function privateJson(value: unknown, status = 200, headers?: HeadersInit) {
  const result = new Headers(headers);
  result.set('Cache-Control', 'private, no-store');
  return Response.json(value, { status, headers: result });
}

export function sameOrigin(request: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  if (!origin || origin !== applicationOrigin()) throw new HttpError(403, 'origin_denied', 'Use the application to make this request.');
}

export async function readJson(request: Request, limit = 240_000): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, 'invalid_content_type', 'Send JSON.');
  if (Number(request.headers.get('content-length') || 0) > limit) throw new HttpError(413, 'body_too_large', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_json', 'A request body is required.');
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new HttpError(413, 'body_too_large', 'The request is too large.'); }
    chunks.push(value);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'invalid_json', 'The request is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_json', 'Send a JSON object.');
  return value as Record<string, unknown>;
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return privateJson({ error: { code: error.code, message: error.message } }, error.status);
  if (error && typeof error === 'object' && 'status' in error && 'code' in error && 'message' in error) {
    const e = error as { status: number; code: string; message: string; revision?: number };
    if (Number.isInteger(e.status) && e.status >= 400 && e.status < 500)
      return privateJson({ error: { code: e.code, message: e.message, revision: e.revision } }, e.status);
  }
  // Never include learner content, provider responses or credentials in diagnostics.
  console.error(JSON.stringify({ event: 'request.failed', name: error instanceof Error ? error.name : 'UnknownError' }));
  return privateJson({ error: { code: 'service_unavailable', message: 'This operation could not finish. Your acknowledged work is preserved. Try again.' } }, 503);
}

export async function handle(request: Request, operation: () => Promise<Response>) {
  try { sameOrigin(request); return await operation(); } catch (error) { return errorResponse(error); }
}
