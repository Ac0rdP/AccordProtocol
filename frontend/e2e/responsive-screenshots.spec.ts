import { expect, test } from "./setup";

const pages = [
  ["landing", "/"],
  ["dashboard", "/app"],
  ["analytics", "/app/analytics"],
] as const;

for (const [name, path] of pages) {
  test(`${name} layout remains stable`, async ({ page }) => {
    await page.goto(path, { waitUntil: "networkidle" });
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}