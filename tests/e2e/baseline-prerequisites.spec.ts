import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario } from '../../lib/interview-practice/types';

// Synthetic intercepted transport. Exact real package binding is tested by the
// server/unit tests; this fixture makes no admission, provider or run request.
const scenario: PublicScenario = {
  id: 'monetary-validation', version: '1.0.0', title: 'Monetary Validation', summary: 'Synthetic original task transport.', durationMinutes: 30, level: 'Intermediate', tags: ['Validation'], language: 'python',
  files: { 'quote.py': '# Synthetic fixture' }, stages: [{ id: 'understand', title: 'Understand', brief: 'Synthetic contract.', requirements: ['Preserve the published contract.'] }], rubric: [], tests: [], drills: [], rights: 'Synthetic browser fixture', runtime: { image: 'python:3.11-slim', timeoutSeconds: 25, memoryMb: 256 },
  preparation: { version: '1', scenarioId: 'monetary-validation', scenarioVersion: '1.0.0', scenarioDigest: 'a'.repeat(64), reviewStatus: 'draft', prerequisites: [{ id: 'money-boundary-tests', title: 'Trace arithmetic and boundary cases', description: 'Practise following a small function, writing expected results, and distinguishing a passing example from a verified contract.', lesson: { id: 'correctness', foundryPath: '/dsa/foundations/correctness' } }] },
};
async function fixture(page: Page) {
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected synthetic request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'preparation-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [scenario], capabilities: { ai: false, coaching: false, voice: false, runner: false, billing: false, accounts: true } } }));
  await page.goto('/interview-practice');
}
test('original-task prerequisites are keyboard-readable and remain guidance in setup', async ({ page }, testInfo) => {
  await fixture(page);
  const preparation = page.locator('.scenario-row .scenario-prerequisites');
  await preparation.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(preparation).toHaveAttribute('open');
  await expect(preparation).toContainText('Expert content review and learner pilot are pending.');
  await expect(preparation).toContainText('Trace arithmetic and boundary cases');
  await expect(preparation).toContainText('They do not assert mastery or block access.');
  await expect(preparation.locator('a')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('baseline-preparation-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await expect(dialog).toContainText('published Intermediate requirements and rubric');
  await expect(dialog.getByRole('heading', { name: 'Suggested prerequisites' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
test('original-task preparation and setup fit a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  await page.locator('.scenario-row .scenario-prerequisites summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('baseline-preparation-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await expect(dialog).toContainText('Suggested prerequisites');
  await dialog.getByRole('button', { name: 'Start session', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath('baseline-preparation-setup-mobile.png') });
});
