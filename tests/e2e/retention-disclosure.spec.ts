import { expect, test } from '@playwright/test';

test('retention rules remain readable and precise without provider or account actions', async ({ page }, testInfo) => {
  const mutations: string[] = [];
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') mutations.push(route.request().url());
    const url = route.request().url();
    if (url.endsWith('/api/auth/session')) return route.fulfill({ json: { user: null, authMode: 'unconfigured' } });
    if (url.endsWith('/capabilities')) return route.fulfill({ json: { capabilities: { ai: false, coaching: false, runner: false, voice: false, billing: false, accounts: false } } });
    return route.fulfill({ status: 404, json: { allowed: false } });
  });
  await page.goto('/settings');
  const notice = page.getByRole('region', { name: 'How long practice data stays' });
  await expect(notice).toBeVisible(); await expect(notice).toContainText('after 30 days'); await expect(notice).toContainText('after 62 days');
  await expect(notice).toContainText('not guaranteed deletion deadlines'); await expect(notice).toContainText('Pending or uncertain charges');
  await expect(notice).toContainText('not stored for replay'); await expect(notice).toContainText('cannot be revoked');
  await expect(notice).toContainText('No cleanup schedule or provider/backup expiry is established');
  await expect(notice.locator('dt')).toHaveCount(5); await expect(notice.getByRole('button')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await notice.getByText('Request and deletion records', { exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('retention-periods-mobile.png') });
  expect(mutations).toEqual([]);
});
