import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/auth/callback/route';

const mocks = vi.hoisted(() => ({ client: vi.fn(), cookies: vi.fn(), exchange: vi.fn(), getAll: vi.fn(), set: vi.fn() }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.client }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));

const failure = 'https://foundry.example/settings?error=sign-in-failed';
const callback = (query = '') => new Request(`https://untrusted-request.example/auth/callback${query}`);
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('APP_URL', 'https://foundry.example');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.invalid'); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-only');
  vi.clearAllMocks();
  mocks.getAll.mockReturnValue([{ name: 'existing', value: 'synthetic-cookie' }]);
  mocks.cookies.mockResolvedValue({ getAll: mocks.getAll, set: mocks.set });
  mocks.exchange.mockResolvedValue({ error: null });
  mocks.client.mockImplementation(() => ({ auth: { exchangeCodeForSession: mocks.exchange } }));
});
afterEach(() => { vi.unstubAllEnvs(); });

async function expectFailure(request: Request, location = failure) {
  const response = await GET(request);
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(location);
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(await response.text()).toBe('');
}

describe('sign-in callback failure recovery', () => {
  it('redirects a missing or provider-rejected link without attempting an exchange or reflecting provider parameters', async () => {
    await expectFailure(callback('?error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL&next=https://attacker.invalid'));
    expect(mocks.client).not.toHaveBeenCalled(); expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('handles a returned exchange failure without exposing its text', async () => {
    mocks.exchange.mockResolvedValue({ error: { message: 'PRIVATE_PROVIDER_DETAIL' } });
    await expectFailure(callback('?code=synthetic-code')); expect(mocks.exchange).toHaveBeenCalledWith('synthetic-code');
  });
  it('handles a thrown exchange failure without exposing its text', async () => {
    mocks.exchange.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL'));
    await expectFailure(callback('?code=synthetic-code'));
  });
  it('handles a thrown client construction failure', async () => {
    mocks.client.mockImplementation(() => { throw new Error('PRIVATE_CONFIGURATION_DETAIL'); });
    await expectFailure(callback('?code=synthetic-code')); expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('handles an unavailable cookie context without claiming sign-in succeeded', async () => {
    mocks.cookies.mockRejectedValue(new Error('PRIVATE_COOKIE_DETAIL'));
    await expectFailure(callback('?code=synthetic-code')); expect(mocks.client).not.toHaveBeenCalled();
  });
  it('handles missing provider configuration without making an exchange call', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    await expectFailure(callback('?code=synthetic-code')); expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it.each(['', 'not a URL', 'javascript:untrusted', 'file:///private/config'])('uses a relative fixed failure path when APP_URL is unusable (%s)', async value => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('APP_URL', value);
    await expectFailure(callback('?code=synthetic-code&next=//attacker.invalid'), '/settings?error=sign-in-failed');
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.invalid/private', '//attacker.invalid', '/settings?error=other'])('ignores untrusted next on successful exchange (%s)', async next => {
    const response = await GET(callback(`?code=synthetic-code&next=${encodeURIComponent(next)}`));
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('https://foundry.example/interview-practice');
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).toBe('');
  });
  it('preserves the existing request-cookie and outgoing-cookie Supabase adapter', async () => {
    mocks.client.mockImplementation((_url, _key, options) => ({ auth: { exchangeCodeForSession: async (code: string) => {
      expect(code).toBe('synthetic-code'); expect(options.cookies.getAll()).toEqual([{ name: 'existing', value: 'synthetic-cookie' }]);
      options.cookies.setAll([{ name: 'sb-fixture-auth', value: 'synthetic-session', options: { httpOnly: true, sameSite: 'lax', path: '/' } }]);
      return { error: null };
    } } }));
    const response = await GET(callback('?code=synthetic-code'));
    expect(response.headers.get('location')).toBe('https://foundry.example/interview-practice');
    expect(mocks.set).toHaveBeenCalledWith('sb-fixture-auth', 'synthetic-session', { httpOnly: true, sameSite: 'lax', path: '/' });
  });
});
