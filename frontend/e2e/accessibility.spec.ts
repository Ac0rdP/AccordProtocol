import { test, expect } from "./setup";
import axe from "axe-core";

/**
 * Injects axe-core into the active page and asserts that no WCAG 2.1 AA
 * accessibility violations exist.
 */
async function assertNoA11yViolations(page: any, pageName: string) {
  // Inject the bundled axe-core source script into the browser context
  await page.evaluate(axe.source);

  // Run the accessibility scan across all standard WCAG rules
  const results = await page.evaluate(async () => {
    // @ts-ignore
    return await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
  });

  const violations = results.violations;
  if (violations.length > 0) {
    const formatted = violations.map((v: any) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      helpUrl: v.helpUrl,
      targets: v.nodes.map((n: any) => n.target.join(", ")),
    }));
    console.error(`Accessibility violations on ${pageName}:`, JSON.stringify(formatted, null, 2));
  }

  expect(violations, `Expected 0 accessibility violations on ${pageName}`).toEqual([]);
}

test.describe("End-to-End Accessibility (Issue #851)", () => {
  test("landing page has no accessibility violations", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Landing Page");
  });

  test("documentation page has no accessibility violations", async ({ page }) => {
    await page.goto("/docs");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Docs Page");
  });

  test("app dashboard has no accessibility violations", async ({ page }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Dashboard Page");
  });

  test("onboarding page has no accessibility violations", async ({ page }) => {
    await page.goto("/app/onboarding");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Onboarding Page");
  });

  test("owners page has no accessibility violations", async ({ page }) => {
    await page.goto("/app/owners");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Owners Page");
  });

  test("recurring payments page has no accessibility violations", async ({ page }) => {
    await page.goto("/app/recurring");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Recurring Page");
  });

  test("analytics page has no accessibility violations", async ({ page }) => {
    await page.goto("/app/analytics");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Analytics Page");
  });

  test("history page has no accessibility violations", async ({ page }) => {
    await page.goto("/app/history");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "History Page");
  });

  test("settings page has no accessibility violations", async ({ page }) => {
    await page.goto("/app/settings");
    await page.waitForLoadState("networkidle");
    await assertNoA11yViolations(page, "Settings Page");
  });
});
