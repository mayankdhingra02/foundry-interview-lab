import { expect, test, type Page } from "@playwright/test";

// Frontend contract fixtures only. Every billing/Stripe HTTP response below is
// intercepted; these tests make no merchant request and establish no entitlement.
const allowance = { enabled: true, freeSessionsPerMonth: 2, sessionsPerPaidPeriod: 12, remaining: 1, paidRemaining: 0, freeRemaining: 1, blocked: false, subscriptionStatus: "none", periodEnd: null, hasCustomer: false };
async function settingsFixture(page: Page, options: { billing?: boolean; local?: boolean; status?: object } = {}) {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "73efbd73-729b-4b58-80ab-8c67240ef3db", email: "frontend-fixture@example.invalid", local: options.local ?? false }, authMode: options.local ? "local" : "supabase" } }));
  await page.route("**/api/interview-practice/capabilities", route => route.fulfill({ json: { capabilities: { ai: false, runner: false, voice: false, billing: options.billing ?? true, accounts: !options.local } } }));
  let statusCalls = 0;
  await page.route("**/api/billing", route => { statusCalls++; return route.fulfill({ json: options.status ?? allowance }); });
  return () => statusCalls;
}

for (const configuration of [{ billing: false, local: false }, { billing: true, local: true }]) {
  test(`billing makes no request when disabled=${!configuration.billing} or local=${configuration.local}`, async ({ page }) => {
    const statusCalls = await settingsFixture(page, configuration);
    let actions = 0; await page.route("**/api/billing/**", route => { actions++; return route.fulfill({ status: 500, json: { error: { message: "Unexpected billing action" } } }); });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Billing and practice allowance" })).toBeVisible();
    await expect(page.getByText(configuration.local ? "Billing requires a verified Engineering Foundry account. Local development accounts do not use checkout." : "Billing is not enabled for this deployment.", { exact: true })).toBeVisible();
    expect(statusCalls()).toBe(0); expect(actions).toBe(0);
    await expect(page.getByRole("button", { name: "Review subscription", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage billing", exact: true })).toHaveCount(0);
  });
}

test("checkout opens only on explicit action and retries with the same request key", async ({ page }, testInfo) => {
  await settingsFixture(page);
  const keys: string[] = [];
  await page.route("**/api/billing/checkout", route => {
    keys.push(route.request().postDataJSON().requestId);
    return route.fulfill(keys.length === 1 ? { status: 503, json: { error: { message: "Fixture interrupted request. Retry the same action." } } } : { json: { id: "cs_test_frontend_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_frontend_fixture", expiresAt: 1_800_000_000 } });
  });
  await page.route("https://checkout.stripe.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Frontend fixture checkout destination</h1>" }));
  await page.goto("/settings");
  await expect(page.locator(".billing-allowance > div").filter({ has: page.getByText("Practice sessions available", { exact: true }) }).locator("dd")).toHaveText("1");
  await expect(page.getByText("Review price and payment terms in Stripe before purchasing.", { exact: false })).toBeVisible();
  expect(keys).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("billing-allowance-fixture.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("billing-mobile-fixture.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Review subscription", exact: true }).click();
  await expect(page.getByRole("region", { name: "Billing and practice allowance" }).getByRole("alert")).toContainText("Retry the same action");
  await page.getByRole("button", { name: "Review subscription", exact: true }).click();
  await page.waitForURL("https://checkout.stripe.com/c/pay/cs_test_frontend_fixture");
  await expect(page.getByRole("heading", { name: "Frontend fixture checkout destination" })).toBeVisible();
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(keys[0]).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);
});

test("existing subscriptions open only the explicit billing portal action", async ({ page }) => {
  await settingsFixture(page, { status: { ...allowance, remaining: 5, paidRemaining: 4, subscriptionStatus: "active", hasCustomer: true, periodEnd: "2026-11-09T12:00:00Z" } });
  let calls = 0; await page.route("**/api/billing/portal", route => { calls++; expect(route.request().postDataJSON().requestId).toMatch(/^[a-zA-Z0-9_-]{8,128}$/); return route.fulfill({ json: { id: "bps_frontend_fixture", url: "https://billing.stripe.com/p/session/frontend_fixture" } }); });
  await page.route("https://billing.stripe.com/**", route => route.fulfill({ contentType: "text/html", body: "<h1>Frontend fixture portal destination</h1>" }));
  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Manage billing", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review subscription", exact: true })).toHaveCount(0); expect(calls).toBe(0);
  await page.getByRole("button", { name: "Manage billing", exact: true }).click();
  await page.waitForURL("https://billing.stripe.com/p/session/frontend_fixture");
  expect(calls).toBe(1);
});

test("a returned billing URL cannot navigate to an unapproved destination", async ({ page }) => {
  await settingsFixture(page);
  await page.route("**/api/billing/checkout", route => route.fulfill({ json: { url: "https://unapproved.example.invalid/payment" } }));
  await page.goto("/settings"); await page.getByRole("button", { name: "Review subscription", exact: true }).click();
  await expect(page.getByRole("region", { name: "Billing and practice allowance" }).getByRole("alert")).toContainText("not a supported secure Stripe destination");
  await expect(page).toHaveURL(/\/settings$/);
});
