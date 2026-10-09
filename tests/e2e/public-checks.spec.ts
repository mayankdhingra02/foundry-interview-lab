import { expect, test, type Page } from '@playwright/test';
import type { PublicScenario, SessionView } from '../../lib/interview-practice/types';

// Authored source is synthetic browser-contract data. These checks do not run
// Python, start a container, call models, or qualify the source's correctness.
const id = 'fe9c598e-a188-49f1-aeec-2cc73a226ca0';
const now = new Date().toISOString();
const title = 'Disclosed boundary checks';
const source = '# Public authored fixture\n# </pre><script>window.publicCheckExecuted = true</script>\nassert example("<img src=x>") == "expected"\n';
const protectedSource = 'PROTECTED_SOURCE_MUST_NOT_RENDER';
const scenario: PublicScenario = {
  id: 'public-checks-fixture', version: '1.0.0', title: 'Public checks fixture', summary: 'Inspect a disclosed contract.', durationMinutes: 45,
  level: 'Intermediate', tags: ['verification'], language: 'python', files: { 'main.py': '# Saved implementation' },
  stages: [{ id: 'inspect', title: 'Inspect', brief: 'Read the contract.', requirements: ['Preserve the public interface.'] }],
  rubric: [{ id: 'verification', name: 'Verification', description: 'Use recorded evidence.', anchors: { strong: 'Clear', developing: 'Partial', needsWork: 'Missing' } }],
  // Include protected source deliberately to exercise defensive display
  // filtering. Actual transport separately omits it on the server.
  tests: [{ id: 'public-check', title, visible: true, source, timeoutSeconds: 10 }, { id: 'protected-check', title: 'Protected fixture check', visible: false, source: protectedSource, timeoutSeconds: 10 }],
  drills: [], rights: 'Original synthetic fixture.', runtime: { image: 'python:3.11-slim', timeoutSeconds: 20, memoryMb: 128 },
};
function attempt(): SessionView {
  return {
    id, scenarioId: scenario.id, scenarioVersion: scenario.version, scenario: structuredClone(scenario), mode: 'practice', lifecycle: 'active', stageId: 'inspect', revision: 1,
    configuration: { role: 'Backend engineer', level: 'Intermediate', skills: ['verification'], targetMinutes: 45, aiHelp: false, voice: false, accommodations: [] },
    files: scenario.files, codeFrozenSnapshotId: null, frozenEvidence: null, events: [], turns: [], runs: [], jobs: [], assistantMessages: [], editProposals: [], reports: [], evidence: [],
    usage: { reservedUsd: 0, spentUsd: 0, uncertainUsd: 0, runs: 0, aiCalls: 0 }, createdAt: now, updatedAt: now, hintsOpened: 0, completedDrillIds: [], promptExposure: 'fresh',
  };
}
async function fixture(page: Page, session = attempt()) {
  const mutations: string[] = [];
  await page.route('**/api/**', route => { if (route.request().method() !== 'GET') mutations.push(route.request().url()); return route.fulfill({ status: 501, json: { error: { message: 'Unexpected fixture request.' } } }); });
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'public-checks-owner', local: false }, authMode: 'supabase' } }));
  await page.route('**/api/internal/access', route => route.fulfill({ json: { allowed: false } }));
  await page.route(`**/api/interview-practice/sessions/${id}`, route => route.fulfill({ json: {
    session,
    // A separate current-catalog response must never replace the package
    // source admitted to this saved attempt.
    scenario: { ...scenario, version: '2.0.0', tests: [{ ...scenario.tests[0], source: '# NEW CATALOG SOURCE' }] },
    capabilities: { ai: false, coaching: false, runner: false, voice: false, billing: false, accounts: true },
  } }));
  await page.route(`**/api/interview-practice/sessions/${id}/reviews`, route => route.fulfill({ json: { cases: [] } }));
  await page.goto(`/interview-practice/${id}`);
  return { session, mutations };
}
async function openSource(page: Page) {
  await page.locator('.public-checks > summary').click();
  await page.locator('.public-checks .test-result > summary').click();
  return page.getByRole('region', { name: `Source for ${title}`, exact: true });
}

test('public authored source is readable before any run, escaped, and distinct from test results', async ({ page }) => {
  const data = await fixture(page); const code = await openSource(page);
  await expect(code).toHaveText(source);
  await expect(code.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, 'publicCheckExecuted'))).toBe(false);
  await expect(page.locator('body')).not.toContainText(protectedSource);
  await expect(page.locator('.public-checks')).not.toContainText('Protected fixture check');
  await expect(page.locator('.public-checks')).toContainText('Read-only authored source · Scenario version 1.0.0');
  await expect(page.locator('.public-checks')).toContainText('Execution results are recorded separately.');
  await expect(page.getByText('The code runner is not configured.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run tests', exact: true })).toBeDisabled();
  expect(data.session.runs).toEqual([]); expect(data.mutations).toEqual([]);
});

test('keyboard users can expand public checks and focus source without a trap', async ({ page }) => {
  await fixture(page); const outer = page.locator('.public-checks > summary');
  await outer.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.public-checks')).toHaveAttribute('open', '');
  await page.keyboard.press('Tab'); const check = page.locator('.public-checks .test-result > summary'); await expect(check).toBeFocused();
  await page.keyboard.press('Enter'); await page.keyboard.press('Tab');
  await expect(page.getByRole('region', { name: `Source for ${title}`, exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(check).toBeFocused();
  await page.keyboard.press('Space'); await expect(page.locator('.public-checks .test-result')).not.toHaveAttribute('open');
  await page.keyboard.press('Shift+Tab'); await expect(outer).toBeFocused();
});

test('long public source remains readable within a narrow viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const session = attempt(); session.scenario.tests[0].source = source + '# ' + 'long-boundary-value'.repeat(80);
  await fixture(page, session); const code = await openSource(page); await code.scrollIntoViewIfNeeded();
  const bounds = await code.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(code).toContainText('long-boundary-value');
  await page.locator('.test-output').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: testInfo.outputPath('public-checks-mobile.png'), fullPage: true });
});

test('refresh and completed review preserve the admitted public source and version', async ({ page }) => {
  const { session, mutations } = await fixture(page); await openSource(page); await page.reload();
  let code = await openSource(page); await expect(code).toHaveText(source); await expect(page.locator('.public-checks')).toContainText('Scenario version 1.0.0');
  await expect(page.locator('body')).not.toContainText('NEW CATALOG SOURCE');
  session.codeFrozenSnapshotId = 'frozen-snapshot'; session.stageId = 'debrief'; session.lifecycle = 'completed';
  session.reports = [{ id: 'saved-report', generationId: 'saved-generation', createdAt: now, model: 'authored-observation-only', promptVersion: 'fixture-v1', rubricVersion: '1.0.0', evidenceDigest: 'a'.repeat(64), evidence: [], overview: 'No assessment was produced.', rubric: [{ criterionId: 'verification', level: 'Not observed', feedback: 'No assessed evidence.', evidenceIds: [], confidence: 'low' }], nextPractice: [] }];
  await page.reload(); await page.getByText('View saved workspace and conversation', { exact: true }).click();
  code = await openSource(page); await expect(code).toHaveText(source);
  await expect(page.locator('.public-checks')).toContainText('Scenario version 1.0.0'); await expect(page.locator('body')).not.toContainText(protectedSource);
  expect(mutations).toEqual([]);
});

test('legacy attempts without public source show an honest unavailable state', async ({ page }) => {
  const session = attempt(); delete session.scenario.tests[0].source;
  await fixture(page, session); await page.locator('.public-checks > summary').click();
  await expect(page.locator('.public-checks')).toContainText('Public checks (0)');
  await expect(page.locator('.public-checks')).toContainText('Public check source is not available in this saved scenario.');
  await expect(page.locator('.public-checks .test-result')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(protectedSource);
});
