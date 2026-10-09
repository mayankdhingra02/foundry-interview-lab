import { expect, test } from '@playwright/test';

test('setup explains observation-only coaching while other practice remains available', async ({ page }) => {
  const response = await page.request.get('/api/interview-practice/scenarios');
  expect(response.ok()).toBe(true); const catalog = await response.json(); expect(catalog.scenarios.length).toBeGreaterThan(0);
  const message = 'AI report generation is disabled. Recorded work receives a labeled observation-only report.';
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { ...catalog, capabilities: { ...catalog.capabilities, ai: true, coaching: false, details: { ...catalog.capabilities.details, coaching: message } } } }));
  await page.goto('/interview-practice');
  await page.getByRole('button', { name: 'Set up practice', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await expect(dialog.getByText(message, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await expect(dialog).toContainText('Ask questions or preview proposed edits.');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
});

test('closed catalog directs learners to saved attempts without suggesting another filter', async ({ page }) => {
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [], capabilities: { ai: false, coaching: false, runner: false, voice: false, billing: false, accounts: true } } }));
  await page.goto('/interview-practice');
  await expect(page.getByRole('heading', { name: 'New practice is currently closed', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Resume a session', exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up practice', exact: true })).toHaveCount(0);
  await expect(page.getByText('Try another search or choose all skills.', { exact: true })).toHaveCount(0);
});
