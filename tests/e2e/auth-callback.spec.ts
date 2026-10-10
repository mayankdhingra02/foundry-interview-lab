import { expect, test, type Page, type Route } from '@playwright/test';

// Provider HTTP is intercepted. The final test exercises only the real callback's
// missing-code branch, which performs no Supabase exchange.
async function settingsFixture(page: Page, options: { mode?: 'supabase' | 'local' | 'unconfigured'; signedIn?: boolean } = {}) {
  const mode = options.mode ?? 'supabase';
  let signedIn = options.signedIn ?? false;
  const actions: { path: string; body: unknown }[] = [];
  let login: (route: Route) => Promise<void> = route => route.fulfill({ json: { message: 'Check your email for the sign-in link.' } });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') actions.push({ path, body: request.postDataJSON() });
    if (path === '/api/auth/session') return route.fulfill({ json: { user: signedIn ? { id: 'auth-fixture-owner', email: mode === 'local' ? undefined : 'current@example.invalid', local: mode === 'local' } : null, authMode: mode } });
    if (path === '/api/interview-practice/capabilities') return route.fulfill({ json: { capabilities: { ai: false, runner: false, voice: false, billing: false, accounts: mode === 'supabase' } } });
    if (path === '/api/auth/login') return login(route);
    if (path === '/api/auth/local') { signedIn = true; return route.fulfill({ json: { user: { id: 'auth-fixture-owner', local: true } } }); }
    return route.fulfill({ status: 404, json: { allowed: false } });
  });
  return { actions, setLogin: (handler: typeof login) => { login = handler; } };
}
const failedNotice = (page: Page) => page.getByRole('alert').filter({ hasText: 'Sign-in link could not be used.' });

test('failed link offers explicit keyboard retry, keeps email private and clears the marker only after acknowledgement', async ({ page }, testInfo) => {
  const fixture = await settingsFixture(page);
  let release: (() => void) | undefined;
  fixture.setLogin(async route => { await new Promise<void>(resolve => { release = resolve; }); await route.fulfill({ json: { message: 'Check your email for the sign-in link.' } }); });
  await page.goto('/settings?error=sign-in-failed&error_description=PRIVATE_PROVIDER_DETAIL&next=https://attacker.invalid');
  await expect(failedNotice(page)).toContainText('It may have expired, already been used');
  await expect(failedNotice(page)).toContainText('No email is sent automatically');
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('');
  expect(fixture.actions).toEqual([]); await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL');
  await page.setViewportSize({ width: 390, height: 844 });
  const email = page.getByLabel('Email address', { exact: true }); await email.fill('learner@example.invalid'); await email.focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Send a new sign-in link', exact: true })).toBeFocused(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled(); await expect.poll(() => fixture.actions.length).toBe(1);
  await expect(failedNotice(page)).toBeVisible(); await expect(page).toHaveURL(/error=sign-in-failed/);
  expect(fixture.actions).toEqual([{ path: '/api/auth/login', body: { email: 'learner@example.invalid' } }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sign-in-retry-mobile.png'), fullPage: true });
  release?.(); await expect(page.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible(); await expect(failedNotice(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has('error')).toBe(false);
  await page.reload(); await expect(page.getByRole('button', { name: 'Send sign-in link', exact: true })).toBeVisible(); await expect(failedNotice(page)).toHaveCount(0); expect(fixture.actions).toHaveLength(1);
});

for (const failure of ['returned-503', 'invalid-json', 'network'] as const) {
  test(`a ${failure} retry failure stays visible, preserves the email and permits an explicit retry`, async ({ page }) => {
    const fixture = await settingsFixture(page);
    fixture.setLogin(route => failure === 'network' ? route.abort('failed') : failure === 'invalid-json' ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'PRIVATE_PROVIDER_DETAIL' }) : route.fulfill({ status: 503, json: { error: { message: 'PRIVATE_PROVIDER_DETAIL' } } }));
    await page.goto('/settings?error=sign-in-failed'); await page.getByLabel('Email address', { exact: true }).fill('learner@example.invalid');
    await page.getByRole('button', { name: 'Send a new sign-in link', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'A sign-in link could not be sent.' })).toBeVisible(); await expect(failedNotice(page)).toBeVisible();
    await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('learner@example.invalid'); await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL');
    await expect(page.getByRole('button', { name: 'Send a new sign-in link', exact: true })).toBeEnabled(); expect(fixture.actions).toHaveLength(1);
    fixture.setLogin(route => route.fulfill({ json: { message: 'Check your email for the sign-in link.' } }));
    await page.getByRole('button', { name: 'Send a new sign-in link', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Check your email' })).toBeVisible(); expect(fixture.actions).toHaveLength(2); expect(fixture.actions[1]).toEqual(fixture.actions[0]);
  });
}

test('failed-link advice preserves the explicit local-account flow and makes no hosted sign-in request', async ({ page }) => {
  const fixture = await settingsFixture(page, { mode: 'local' }); await page.goto('/settings?error=sign-in-failed');
  await expect(failedNotice(page)).toContainText('Email sign-in is not used in this development mode.'); await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0); expect(fixture.actions).toEqual([]);
  await page.getByRole('button', { name: 'Enable local practice', exact: true }).click(); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  expect(fixture.actions).toEqual([{ path: '/api/auth/local', body: {} }]);
});

test('an existing signed-in account is preserved when another link fails', async ({ page }) => {
  const fixture = await settingsFixture(page, { signedIn: true }); await page.goto('/settings?error=sign-in-failed');
  await expect(failedNotice(page)).toContainText('You are currently signed in. Review the account below'); await expect(page.getByText('current@example.invalid', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible(); expect(fixture.actions).toEqual([]);
});

test('unconfigured accounts explain availability without offering a nonfunctional email retry', async ({ page }) => {
  const fixture = await settingsFixture(page, { mode: 'unconfigured' }); await page.goto('/settings?error=sign-in-failed');
  await expect(failedNotice(page)).toContainText('If it is unavailable, try again later.'); await expect(page.getByText('Account access is not configured for this deployment.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveCount(0); expect(fixture.actions).toEqual([]);
});

test('unknown error query values are not reflected or treated as a failed-link marker', async ({ page }) => {
  const fixture = await settingsFixture(page); await page.goto('/settings?error=PRIVATE_PROVIDER_DETAIL');
  await expect(page.getByRole('button', { name: 'Send sign-in link', exact: true })).toBeVisible(); await expect(failedNotice(page)).toHaveCount(0); await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL'); expect(fixture.actions).toEqual([]);
});

test('real missing-code callback reaches generic Settings recovery without exchanging a provider code', async ({ page, baseURL }) => {
  const fixture = await settingsFixture(page);
  const response = await page.request.get('/auth/callback?error=access_denied&error_description=PRIVATE_PROVIDER_DETAIL&next=https://attacker.invalid', { maxRedirects: 0 });
  expect(response.status()).toBe(303); expect(response.headers()['cache-control']).toBe('no-store'); expect(response.headers()['referrer-policy']).toBe('no-referrer');
  const destination = new URL(response.headers().location, baseURL); expect(destination.origin).toBe(new URL(baseURL!).origin); expect(destination.pathname + destination.search).toBe('/settings?error=sign-in-failed');
  await page.goto(destination.href); await expect(failedNotice(page)).toBeVisible(); await expect(page.locator('body')).not.toContainText('PRIVATE_PROVIDER_DETAIL'); expect(fixture.actions).toEqual([]);
});
