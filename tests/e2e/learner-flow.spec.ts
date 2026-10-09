import { expect, test } from "@playwright/test";

test("learner can save code, run real checks, debrief, review evidence, and delete an attempt", async ({ page, request }, testInfo) => {
  const capabilityResponse = await request.get("/api/interview-practice/capabilities");
  expect(capabilityResponse.ok()).toBeTruthy();
  const { capabilities } = await capabilityResponse.json();
  test.skip(!capabilities.runner, "Release gate: an actual isolated runner must be configured to exercise this end-to-end test.");

  await page.goto("/interview-practice");
  await expect(page.getByRole("heading", { name: "Interview practice", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up practice", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Set up your session" })).toBeVisible();
  await page.getByRole("button", { name: "Start session", exact: true }).click();
  await page.waitForURL(/\/interview-practice\/[^/?]+$/);
  const sessionPath = new URL(page.url()).pathname;
  const sessionId = sessionPath.split("/").at(-1)!;

  await page.getByLabel("Active file", { exact: true }).selectOption("quote.py");
  const editor = page.getByRole("textbox", { name: "Edit quote.py. Tab moves to the next control.", exact: true });
  const original = await editor.inputValue();
  const changed = `${original}\n# E2E: recorded practice observation\n`;
  await editor.fill(changed);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel("Active file", { exact: true }).selectOption("quote.py");
  await expect(editor).toHaveValue(changed);

  await page.getByRole("button", { name: "Run tests", exact: true }).click();
  await expect(page.locator(".run-reference")).toBeVisible({ timeout: 90_000 });
  const runResponse = await page.request.get(`/api/interview-practice/sessions/${sessionId}`);
  expect(runResponse.ok()).toBeTruthy();
  const { session: afterRun } = await runResponse.json();
  const run = afterRun.runs.at(-1);
  expect(run.status, "The configured runner must really execute the saved code.").toBe("completed");
  expect(run.tests.length).toBeGreaterThan(0);
  expect(run.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(run.exitCode).not.toBeNull();
  await page.screenshot({ path: testInfo.outputPath("workspace.png"), fullPage: true });

  await page.getByRole("tab", { name: "Coding assistant", exact: true }).click();
  if (!capabilities.ai) await expect(page.getByRole("heading", { name: "AI is not configured" })).toBeVisible();
  await page.getByRole("tab", { name: "Interviewer", exact: true }).click();
  await page.getByRole("button", { name: "Finish coding", exact: true }).click();
  await page.getByRole("button", { name: "Finish coding and start debrief", exact: true }).click();
  await expect(page.getByText("Coding is finished.", { exact: true })).toBeVisible();
  await expect(editor).toHaveAttribute("readonly", "");
  await page.getByLabel("Your explanation", { exact: true }).fill("I ran the checks against the saved snapshot. The current calculation uses floating point and round(), so I would replace it with integer arithmetic and half-up rounding at invoice level. I still need validation for booleans and invalid inputs.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Final submit", exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.getByRole("button", { name: "Final submit", exact: true }).click();
  await page.getByRole("dialog", { name: "Submit your completed attempt?" }).getByRole("button", { name: "Final submit", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your practice review", exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".finding").first()).toBeVisible();
  await page.locator(".evidence-link").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".evidence-content")).not.toBeEmpty();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("report.png"), fullPage: true });

  await page.getByRole("link", { name: "History", exact: true }).click();
  const row = page.locator("tr").filter({ has: page.locator(`a.table-title[href="${sessionPath}"]`) });
  await expect(row).toContainText("Completed");
  const download = page.waitForEvent("download");
  await row.getByRole("button", { name: /^Export / }).click();
  expect((await download).suggestedFilename()).toContain(sessionId);
  await row.getByRole("button", { name: /^Delete / }).click();
  await page.getByRole("dialog", { name: "Delete this practice attempt?" }).getByRole("button", { name: "Delete attempt", exact: true }).click();
  await expect(row).toHaveCount(0);
  const deleted = await page.request.get(`/api/interview-practice/sessions/${sessionId}`);
  expect(deleted.status()).toBe(404);
});

test("catalog, navigation and setup remain usable on a narrow screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/interview-practice");
  await page.getByRole("button", { name: "Set up practice", exact: true }).first().waitFor();
  await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up practice", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "Set up your session" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Target duration (advisory)", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("catalog-mobile.png"), fullPage: true });
});
