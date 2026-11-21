import { expect, test } from "@playwright/test";
import {
  CO_OWNER,
  SHARE_REGRESSION_FIXTURE,
  mockSignedOutSorobanRpc,
} from "./share-links-fixture";

/**
 * End-to-end coverage for public share links, deep links, and embed widgets
 * from a signed-out browser (#1047).
 *
 * Imports `test` from `@playwright/test` directly (NOT `./setup`) so that no
 * Freighter wallet stub is injected and `window.freighter` remains undefined.
 */
test.describe("signed-out public share links, deep links, and embed widgets", () => {
  test.describe("success cases", () => {
    test("opens a public proposal share link (/proposals/1) in a signed-out browser and renders read-only details", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);
      await page.goto("/proposals/1");

      // Verify browser is genuinely signed-out (no Freighter injected)
      const hasFreighter = await page.evaluate(
        () => Boolean((window as unknown as { freighter?: unknown }).freighter),
      );
      expect(hasFreighter).toBe(false);

      // Canonical redirect to /app/proposals/1 without hitting "Freighter wallet required"
      await expect(page).toHaveURL(/\/app\/proposals\/1$/);
      await expect(
        page.getByRole("heading", { name: "Proposal #1" }),
      ).toBeVisible();
      await expect(
        page.getByText("Public Share Grant Payout"),
      ).toBeVisible();
      await expect(page.getByText(CO_OWNER)).toBeVisible();
      await expect(
        page.getByText("Freighter wallet required"),
      ).not.toBeVisible();
    });

    test("resolves a query-parameter deep link (/app?proposal=2) in a signed-out browser without exposing execute controls", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);
      await page.goto("/app?proposal=2");

      await expect(page).toHaveURL(/\/app\/proposals\/2$/);
      await expect(
        page.getByRole("heading", { name: "Proposal #2" }),
      ).toBeVisible();
      await expect(
        page.getByText("Deep Link Ready Treasury Transfer"),
      ).toBeVisible();

      // Even though proposal #2 is Ready, a signed-out viewer must not see an Execute button
      await expect(
        page.getByRole("button", { name: /execute proposal/i }),
      ).toHaveCount(0);
    });

    test("renders a proposal embed widget inside a host iframe from a signed-out browser", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);

      // Navigate to origin first, then mount an iframe embedding the proposal widget
      await page.goto("/embed/proposals/1?theme=light&compact=true");
      const directWidget = page.getByTestId("embed-proposal-widget");
      await expect(directWidget).toBeVisible();
      await expect(directWidget).toHaveAttribute("data-theme", "light");
      await expect(directWidget).toHaveAttribute("data-compact", "true");
      await expect(page.getByTestId("embed-proposal-amount")).toContainText(
        "250",
      );
      await expect(page.getByTestId("embed-proposal-approvals")).toHaveText(
        "Approvals: 1 / 2",
      );

      // Verify rendering inside a real host <iframe>
      await page.setContent(`
        <!doctype html>
        <html>
          <body>
            <iframe
              id="accord-embed-frame"
              title="Accord Proposal Embed"
              src="http://localhost:5173/embed/proposals/1?theme=dark"
              width="480"
              height="320"
            ></iframe>
          </body>
        </html>
      `);

      const frame = page.frameLocator("#accord-embed-frame");
      await expect(frame.getByTestId("embed-proposal-widget")).toBeVisible();
      await expect(
        frame.getByTestId("embed-proposal-description"),
      ).toHaveText("Public Share Grant Payout");
      await expect(
        frame.getByTestId("embed-open-proposal-link"),
      ).toHaveAttribute("href", "/proposals/1");
    });

    test("renders the treasury summary embed widget (/embed/treasury) in a signed-out browser", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);
      await page.goto("/embed/treasury?theme=dark");

      const widget = page.getByTestId("embed-treasury-widget");
      await expect(widget).toBeVisible();
      await expect(widget).toContainText("Treasury Overview");
      await expect(widget).toContainText("2 of 2");
      await expect(
        page.getByTestId("embed-open-treasury-link"),
      ).toHaveAttribute("href", "/app");
    });
  });

  test.describe("boundary cases", () => {
    test("rejects boundary proposal IDs 0 and -1 on embed routes and normalizes unknown query params", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);

      await page.goto("/embed/proposals/0?theme=unknown&compact=invalid");
      const zeroError = page.getByTestId("embed-error");
      await expect(zeroError).toBeVisible();
      await expect(zeroError).toContainText("Invalid proposal link");
      await expect(zeroError).toHaveAttribute("data-theme", "dark");
      await expect(zeroError).toHaveAttribute("data-compact", "false");

      await page.goto("/embed/proposals/-1");
      await expect(page.getByTestId("embed-error")).toContainText(
        "Invalid proposal link",
      );
    });

    test("handles Number.MAX_SAFE_INTEGER boundary proposal ID as a valid lookup that resolves to not-found", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);
      await page.goto(`/embed/proposals/${Number.MAX_SAFE_INTEGER}`);

      const notFound = page.getByTestId("embed-not-found");
      await expect(notFound).toBeVisible();
      await expect(notFound).toContainText("Proposal not found");
    });
  });

  test.describe("failure cases and secret redaction", () => {
    test("renders Proposal not found for non-existent and non-numeric share links in a signed-out browser", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);

      await page.goto("/proposals/99999");
      await expect(page).toHaveURL(/\/app\/proposals\/99999$/);
      await expect(page.getByText("Proposal not found")).toBeVisible();

      await page.goto("/proposals/not-a-valid-id");
      await expect(page).toHaveURL(/\/app\/proposals\/invalid$/);
      await expect(page.getByText("Proposal not found")).toBeVisible();
    });

    test("surfaces an embed error state when Soroban RPC fails while redacting bearer tokens", async ({
      page,
    }) => {
      const syntheticSecret = ["rpc", "secret", "token", "9876543210abcdef"].join(
        "_",
      );
      await mockSignedOutSorobanRpc(page, {
        failRpcWithSecret: syntheticSecret,
      });

      await page.goto("/embed/proposals/1");
      const errBox = page.getByTestId("embed-error");
      await expect(errBox).toBeVisible();
      await expect(errBox).toContainText("Unable to load embedded proposal");

      const text = (await errBox.textContent()) ?? "";
      expect(text).not.toContain(syntheticSecret);
      expect(text).toContain("[REDACTED]");
    });
  });

  test.describe("regression fixture", () => {
    test("prevents path-traversal deep links (/app?proposal=../settings) from escaping to /app/settings", async ({
      page,
    }) => {
      await mockSignedOutSorobanRpc(page);
      await page.goto(SHARE_REGRESSION_FIXTURE.maliciousUrl);

      await expect(page).toHaveURL(
        new RegExp(`${SHARE_REGRESSION_FIXTURE.expectedSafePath}$`),
      );
      await expect(page.getByText("Proposal not found")).toBeVisible();
    });
  });
});
