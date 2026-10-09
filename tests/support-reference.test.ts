import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordOperationalFailure } from '../lib/server/diagnostics';
import { errorResponse, handle, HttpError } from '../lib/server/http';
import { api, ApiError } from '../features/interview-practice/client';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reference = '12345678-1234-4234-9234-123456789012';
const otherReference = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const log = vi.fn<(line: string) => void>();
beforeEach(() => { log.mockReset(); vi.spyOn(console, 'error').mockImplementation(log); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('operational support references', () => {
  it('preserves a known operational response and emits exactly its opaque reference and static category', async () => {
    const response = errorResponse(new HttpError(503, 'runner_unavailable', 'Execution is unavailable. Your work is saved.'));
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(body.error).toEqual({ code: 'runner_unavailable', message: 'Execution is unavailable. Your work is saved.', reference: expect.stringMatching(uuid) });
    expect(response.headers.get('x-practice-reference')).toBe(body.error.reference);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual({ schemaVersion: 1, event: 'request.failed', reference: body.error.reference, status: 503, category: 'execution_unavailable' });
  });

  it('redacts arbitrary error names, messages, stacks, properties and codes from diagnostic output', async () => {
    const secret = 'PRIVATE-CODE-TRANSCRIPT-TOKEN';
    const error = Object.assign(new Error(secret), { name: secret, stack: secret, code: secret, request: secret, provider: secret, reference });
    const response = errorResponse(error), body = await response.json();
    expect(response.status).toBe(503);
    expect(body.error.code).toBe('service_unavailable');
    expect(body.error.message).toBe('This operation could not finish. Your acknowledged work is preserved. Try again.');
    expect(body.error.reference).not.toBe(reference);
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.parse(log.mock.calls[0][0]).category).toBe('unexpected_failure');
    recordOperationalFailure(502, secret);
    expect(JSON.parse(log.mock.calls[1][0]).category).toBe('unexpected_failure');
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
  });

  it.each([400, 401, 403, 404, 409, 410, 413, 415, 429])('does not reference or log learner/request state status %s', async status => {
    const response = errorResponse(new HttpError(status, 'unchanged_code', 'Unchanged message.'));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: 'unchanged_code', message: 'Unchanged message.' } });
    expect(response.headers.get('x-practice-reference')).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it('preserves structural domain conflicts and revision details without importing forged references', async () => {
    const detail = { status: 409, code: 'revision_conflict', message: 'Reload the acknowledged revision.', revision: 7, reference };
    const response = errorResponse(detail);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: detail.code, message: detail.message, revision: 7 } });
    expect(response.headers.get('x-practice-reference')).toBeNull(); expect(log).not.toHaveBeenCalled();
  });

  it('ignores incoming references and private request context, including concurrent failures', async () => {
    const secret = 'PRIVATE-PATH-QUERY-BODY';
    const responses = await Promise.all(Array.from({ length: 12 }, async () => handle(new Request(`http://localhost/${secret}?token=${secret}`, { headers: { 'X-Practice-Reference': reference, 'X-Request-Id': reference, authorization: secret } }), async () => { throw new Error(secret); })));
    const bodies = await Promise.all(responses.map(response => response.json()));
    const ids = bodies.map(body => body.error.reference);
    expect(new Set(ids).size).toBe(12); expect(ids.every(id => uuid.test(id) && id !== reference)).toBe(true);
    expect(log).toHaveBeenCalledTimes(12); expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(new Set(log.mock.calls.map(([line]) => JSON.parse(line).reference))).toEqual(new Set(ids));
  });

  it('keeps the original response when the diagnostic sink throws and handles asynchronous collector rejection', async () => {
    log.mockImplementation(() => { throw new Error('collector outage'); });
    const response = errorResponse(new HttpError(504, 'upstream_timeout', 'Keep this timeout response.'));
    expect(response.status).toBe(504); expect((await response.json()).error.message).toBe('Keep this timeout response.');
    const sink = vi.fn(async () => { throw new Error('async collector outage'); });
    expect(recordOperationalFailure(503, undefined, sink)).toMatch(uuid);
    await Promise.resolve(); await Promise.resolve();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('only permits operational integer statuses and exactly allowlisted categories in its fixed-size record', () => {
    const sink = vi.fn();
    for (const status of [0, 200, 499, 600, 503.5, NaN, Infinity]) expect(recordOperationalFailure(status, 'runner_unavailable', sink)).toBeUndefined();
    expect(sink).not.toHaveBeenCalled();
    const cases = {
      identity_unconfigured: 'identity_unavailable', sign_in_unavailable: 'identity_unavailable',
      storage_unconfigured: 'configuration_unavailable', rollout_unconfigured: 'configuration_unavailable',
      runner_unavailable: 'execution_unavailable', assistant_unavailable: 'assistance_unavailable',
      voice_unavailable: 'voice_unavailable', voice_provider_unavailable: 'voice_unavailable', invalid_speech_audio: 'voice_unavailable',
      billing_unconfigured: 'billing_unavailable', unknown: 'unexpected_failure',
    };
    for (const [code, category] of Object.entries(cases)) {
      recordOperationalFailure(503, code, sink);
      const diagnostic = sink.mock.calls.at(-1)![0];
      expect(diagnostic.category).toBe(category); expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(Object.keys(diagnostic).sort()).toEqual(['category', 'event', 'reference', 'schemaVersion', 'status']);
      expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(200);
    }
  });
});

describe('safe learner-facing reference display', () => {
  it('adds a validated reference while retaining the exact status and recovery detail object', () => {
    const detail = { error: { code: 'service_unavailable', message: 'Saved work is preserved.', reference }, acknowledged: { revision: 9 } };
    const error = new ApiError(detail.error.message, 503, detail);
    expect(error.message).toBe(`Saved work is preserved. Support reference: ${reference}.`);
    expect(error.status).toBe(503); expect(error.detail).toBe(detail); expect(error.reference).toBe(reference);
    expect(new ApiError('Conflict.', 409, detail).message).toBe('Conflict.');
    expect(new ApiError('Conflict.', 409, detail).reference).toBeUndefined();
  });

  it('does not display malformed, oversized or disagreeing reference values', () => {
    for (const candidate of ['private content', '<script>alert(1)</script>', 'a'.repeat(10_000), `${reference}\n`, `${reference}\r\n`, 42, null, {}, otherReference.toUpperCase(), '12345678-1234-1234-9234-123456789012']) {
      const error = new ApiError('Unavailable.', 503, { error: { reference: candidate } });
      expect(error.message).toBe('Unavailable.'); expect(error.reference).toBeUndefined();
    }
    expect(new ApiError('Unavailable.', 503, { error: { reference } }, otherReference).reference).toBeUndefined();
  });

  it('accepts the bounded response header when the error body cannot be parsed, without changing request options', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('not JSON', { status: 502, headers: { 'X-Practice-Reference': reference } }));
    vi.stubGlobal('fetch', fetcher);
    const body = JSON.stringify({ requestId: 'same-request', expectedRevision: 4 });
    await expect(api('/sessions/example/runs', { method: 'POST', body })).rejects.toMatchObject({ status: 502, reference, detail: {}, message: `The request could not be completed. Support reference: ${reference}.` });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toEqual(['/api/interview-practice/sessions/example/runs', { method: 'POST', body, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' } }]);
  });

  it('keeps successful payloads and 409 recovery details unchanged and does not retry', async () => {
    const conflict = { error: { code: 'revision_conflict', message: 'Reload saved work.', revision: 12, reference } };
    const success = { session: { revision: 12 }, reference };
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(conflict, { status: 409, headers: { 'X-Practice-Reference': reference } })).mockResolvedValueOnce(Response.json(success));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/sessions/example')).rejects.toMatchObject({ status: 409, message: 'Reload saved work.', detail: conflict, reference: undefined });
    expect(await api('/sessions/example')).toEqual(success); expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
