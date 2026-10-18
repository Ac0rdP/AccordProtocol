import { test, expect } from "./setup";

test("landing page hero section visual regression", async ({ page }) => {
  await page.goto("/");
  const hero = page.getByTestId("hero-section");
  await expect(hero).toBeVisible();
  await expect(hero).toHaveScreenshot("landing-hero.png");
});
