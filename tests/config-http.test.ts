import { afterEach, describe, expect, it, vi } from 'vitest';
import { authMode, capabilities } from '../lib/server/config';
import { HttpError, privateJson, readJson, sameOrigin } from '../lib/server/http';
import { getActor, localIdentityCookie } from '../lib/server/auth';

afterEach(() => vi.unstubAllEnvs());

describe('identity and request boundary', () => {
  it('never enables local identity in production', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('AUTH_MODE', 'local');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ''); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    expect(authMode()).toBe('unconfigured'); expect(() => localIdentityCookie()).toThrow();
  });
  it('accepts its signed cookie and rejects a tampered cookie', async () => {
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('AUTH_MODE', 'local'); vi.stubEnv('SESSION_SECRET', 'a'.repeat(32));
    const { actor, cookie } = localIdentityCookie();
    expect(await getActor(new Request('http://localhost', { headers: { cookie } }))).toEqual(actor);
    const tampered = cookie.replace(/=(.)/, '=$1x');
    expect(await getActor(new Request('http://localhost', { headers: { cookie: tampered } }))).toBeNull();
  });
  it('rejects browser mutations without the configured origin', () => {
    vi.stubEnv('APP_URL', 'http://127.0.0.1:3000');
    expect(() => sameOrigin(new Request('http://127.0.0.1:3000/api', { method: 'POST' }))).toThrow(HttpError);
    expect(() => sameOrigin(new Request('http://127.0.0.1:3000/api', { method: 'POST', headers: { origin: 'https://evil.example' } }))).toThrow();
    expect(() => sameOrigin(new Request('http://127.0.0.1:3000/api', { method: 'POST', headers: { origin: 'http://127.0.0.1:3000' } }))).not.toThrow();
  });
  it('bounds body reads and rejects arrays or malformed JSON', async () => {
    const req = (body: string) => new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await expect(readJson(req('[]'))).rejects.toThrow();
    await expect(readJson(req('{'))).rejects.toThrow();
    await expect(readJson(req('{"text":"' + 'x'.repeat(100) + '"}'), 40)).rejects.toThrow();
    await expect(readJson(req('{"ok":true}'))).resolves.toEqual({ ok: true });
  });
  it('does not claim provider availability without configuration', () => {
    vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('DEEPGRAM_API_KEY', '');
    expect(capabilities().ai).toBe(false); expect(capabilities().voice).toBe(false);
    expect(privateJson({ ok: true }).headers.get('cache-control')).toContain('no-store');
  });
});
