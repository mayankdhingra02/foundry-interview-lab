import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabasePrivateObjectStore, privateStorageOrigin } from '../lib/server/private-object-store';
import { PRIVATE_CLEANUP_POLICY } from '../lib/interview-practice/private-cleanup';

const origin = 'https://abcdefghijklmnopqrst.supabase.co', owner = randomUUID(), key = `owners/${owner}/sessions/${randomUUID()}/artifacts/${randomUUID()}`;
function fake(response: () => Promise<Response>) { const fetcher = vi.fn<typeof fetch>(response); return { fetcher, store: new SupabasePrivateObjectStore({ url: origin, serviceRoleKey: 'synthetic-never-used', fetch: fetcher }) }; }
afterEach(() => vi.useRealTimers());

describe('Supabase exact private-object cleanup adapter', () => {
  it('rejects arbitrary hosts, URL paths/credentials and implicit loopback targets before network', () => {
    expect(privateStorageOrigin(origin)).toBe(origin);
    expect(privateStorageOrigin('http://127.0.0.1:54321', true)).toBe('http://127.0.0.1:54321');
    for (const url of ['http://127.0.0.1:54321', 'https://example.test', `${origin}/path`, `${origin}?token=x`, 'https://user:pass@abcdefghijklmnopqrst.supabase.co']) expect(() => privateStorageOrigin(url)).toThrow();
  });
  it('requires the exact bucket identity and private status, with bounded response handling', async () => {
    const good = { id: PRIVATE_CLEANUP_POLICY.bucket, name: PRIVATE_CLEANUP_POLICY.bucket, public: false };
    const fixture = fake(async () => Response.json(good)); expect(await fixture.store.verifyPrivateBucket()).toBe(true);
    for (const value of [{ ...good, public: true }, { ...good, id: 'another-bucket' }, { ...good, name: 'another-name' }, { id: good.id }]) { fixture.fetcher.mockResolvedValueOnce(Response.json(value)); expect(await fixture.store.verifyPrivateBucket()).toBe(false); }
    fixture.fetcher.mockResolvedValueOnce(new Response('x'.repeat(20_000))); expect(await fixture.store.verifyPrivateBucket()).toBe(false);
    expect(fixture.fetcher.mock.calls[0][0]).toBe(`${origin}/storage/v1/bucket/interview-lab-private`);
  });
  it('only submits one exact owned key to the fixed bucket and never trusts delete success as absence', async () => {
    const fixture = fake(async () => Response.json([{ name: key }]));
    await fixture.store.remove(owner, key);
    expect(fixture.fetcher.mock.calls[0]).toMatchObject([`${origin}/storage/v1/object/interview-lab-private`, { method: 'DELETE', redirect: 'error', body: JSON.stringify({ prefixes: [key] }) }]);
    await expect(fixture.store.remove(randomUUID(), key)).rejects.toThrow('not_owned'); expect(fixture.fetcher).toHaveBeenCalledTimes(1);
  });
  it('recognizes only exact metadata or coded object absence; generic 404/auth/bucket/invalid responses remain unknown', async () => {
    const fixture = fake(async () => Response.json({ name: key })); expect(await fixture.store.absence(owner, key)).toBe('present');
    fixture.fetcher.mockResolvedValueOnce(Response.json({ code: 'NoSuchKey' }, { status: 404 })); expect(await fixture.store.absence(owner, key)).toBe('absent');
    for (const [status, body] of [[404, { message: 'Not found' }], [400, { code: 'NoSuchBucket' }], [403, { code: 'AccessDenied' }], [200, { name: 'another-key' }], [500, { code: 'NoSuchKey' }]] as const) {
      fixture.fetcher.mockResolvedValueOnce(Response.json(body, { status })); expect(await fixture.store.absence(owner, key)).toBe('unknown');
    }
    fixture.fetcher.mockRejectedValueOnce(new Error('PRIVATE TRANSPORT DIAGNOSTIC')); expect(await fixture.store.absence(owner, key)).toBe('unknown');
    expect(await fixture.store.absence(randomUUID(), key)).toBe('unknown');
  });
  it('does not follow redirects or transfer unbounded diagnostics and checks signals', async () => {
    const fixture = fake(async () => new Response('private trace', { status: 302, headers: { location: 'https://example.test' } })); expect(await fixture.store.absence(owner, key)).toBe('unknown');
    fixture.fetcher.mockResolvedValueOnce(new Response('[]', { headers: { 'content-length': '9999999' } })); expect(await fixture.store.absence(owner, key)).toBe('unknown');
    const controller = new AbortController(); controller.abort();
    fixture.fetcher.mockImplementationOnce(async (_url, init) => { expect(init?.signal?.aborted).toBe(true); throw new Error(); });
    expect(await fixture.store.verifyPrivateBucket(controller.signal)).toBe(false);
  });
  it('bounds a noncooperative transport without turning timeout into absence proof', async () => {
    vi.useFakeTimers(); const fixture = fake(() => new Promise(() => undefined));
    const pending = fixture.store.absence(owner, key);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBe('unknown'); expect(fixture.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
