import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario } from '../../lib/interview-practice/types';
import type { PracticeTier } from '../../lib/interview-practice/curriculum';

// Intercepted browser contracts; no container, provider, or real admission.
function scenario(id: string, tier: PracticeTier, constraint: string): PublicScenario {
  return { id, version: '1.0.0', familyId: 'inventory-reservations', title: `${tier} stock fixture`, summary: constraint, durationMinutes: 30, level: tier, tags: ['Inventory'], language: 'python', files: { 'inventory.py': '# Fixture' },
    curriculum: { tier, calibration: 'unreviewed', constraints: [constraint], prerequisites: [{ id: 'correctness', title: 'Correctness and boundary tests', description: 'Trace a branch and write an assertion.', lesson: { id: 'correctness', foundryPath: '/dsa/foundations/correctness' } }] },
    stages: [{ id: 'understand', title: 'Understand', brief: constraint, requirements: [constraint] }], rubric: [], tests: [], drills: [], rights: 'Original synthetic fixture', runtime: { image: 'python:3.11-slim', timeoutSeconds: 25, memoryMb: 256 } };
}
const junior = scenario('stock-foundations', 'Junior', 'Single-process memory and exact count validation.'), mid = scenario('stock-retries', 'Mid-level', 'Durable SQLite request identity and failure consistency.'), senior = scenario('stock-lifecycle', 'Senior', 'Atomic concurrent reservation and cancellation lifecycle.');
async function fixture(page: Page) {
  const bodies: string[] = [];
  await page.route('**/api/**', route => route.fulfill({ status: 501, json: { error: { message: 'Unexpected synthetic fixture request.' } } }));
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'curriculum-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route('**/api/interview-practice/scenarios', route => route.fulfill({ json: { scenarios: [junior, mid, senior], capabilities: { ai: false, coaching: false, voice: false, runner: false, billing: false, accounts: true } } }));
  await page.route('**/api/interview-practice/sessions', route => {
    bodies.push(route.request().postData()!);
    return route.fulfill({ status: 403, json: { error: { message: 'Synthetic admission stopped before any real session.' } } });
  });
  await page.goto('/interview-practice');
  return bodies;
}
test('task-level selection shows actual distinct tasks and review status', async ({ page }) => {
  await fixture(page);
  const filter = page.getByRole('combobox', { name: 'Task level', exact: true });
  await expect(page.locator('.scenario-row')).toHaveCount(3);
  for (const tier of ['Junior', 'Mid-level', 'Senior']) {
    await filter.selectOption(tier);
    await expect(page.locator('.scenario-row')).toHaveCount(1);
    await expect(page.locator('.scenario-row h2')).toHaveText(`${tier} stock fixture`);
    await expect(page.locator('.scenario-row')).toContainText('Difficulty review pending');
  }
  await filter.selectOption('all'); await expect(page.locator('.scenario-row')).toHaveCount(3);
});
test('changing preparation goal never relabels or substitutes the selected task', async ({ page }) => {
  const bodies = await fixture(page);
  await page.getByRole('combobox', { name: 'Task level', exact: true }).selectOption('Junior');
  await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await dialog.getByRole('combobox', { name: 'Preparation goal level', exact: true }).selectOption('Senior');
  await expect(dialog).toContainText('This task uses its published Junior requirements and rubric.');
  await expect(dialog).toContainText('Your preparation goal does not change the task constraints or difficulty.');
  await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic admission stopped');
  expect(JSON.parse(bodies[0])).toMatchObject({ scenarioId: 'stock-foundations', level: 'Senior' });
});
test('prerequisites are keyboard-readable guidance and do not emit unconfigured links', async ({ page }) => {
  await fixture(page);
  await page.getByRole('combobox', { name: 'Task level', exact: true }).selectOption('Junior');
  const summary = page.locator('.scenario-prerequisites > summary');
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.scenario-prerequisites')).toHaveAttribute('open');
  await expect(page.locator('.scenario-prerequisites')).toContainText('Suggested prerequisites');
  await expect(page.locator('.scenario-prerequisites')).toContainText('Expert difficulty calibration and learner pilot are pending.');
  await expect(page.locator('.scenario-prerequisites')).toContainText('They do not assert mastery or block access.');
  await expect(page.locator('.scenario-prerequisites a')).toHaveCount(0);
  await page.keyboard.press('Enter'); await expect(page.locator('.scenario-prerequisites')).not.toHaveAttribute('open');
});
test('long constraints and setup remain usable on a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page);
  await page.getByRole('combobox', { name: 'Task level', exact: true }).selectOption('Senior');
  await page.locator('.scenario-prerequisites > summary').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('curriculum-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Set up practice', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Set up your session' });
  await expect(dialog).toContainText('Atomic concurrent reservation and cancellation lifecycle.');
  await dialog.getByRole('button', { name: 'Start session', exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeEnabled();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.screenshot({ path: testInfo.outputPath('curriculum-setup-mobile.png') });
});
