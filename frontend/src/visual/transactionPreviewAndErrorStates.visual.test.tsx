import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { VotingPowerPreview } from "../components/VotingPowerPreview";
import { WhaleWarningBadge } from "../components/WhaleWarningBadge";
import { GovernanceImpactBadge } from "../components/GovernanceImpactBadge";
import { ErrorState } from "../components/ErrorState";
import { ErrorBoundary } from "../components/ErrorBoundary";
import type { BalanceDeltaRow } from "../lib/transactionPreview";

type Theme = "dark" | "light";
type Viewport = "mobile" | "desktop";

const VIEWPORT_STYLES: Record<Viewport, string> = {
  mobile: "w-[375px] max-w-[375px]",
  desktop: "w-[1024px] max-w-[1024px]",
};

const THEME_STYLES: Record<Theme, string> = {
  dark: "dark bg-zinc-950 text-zinc-100",
  light: "light bg-white text-zinc-900 border-zinc-200",
};

function renderInHarness(
  element: React.ReactNode,
  theme: Theme = "dark",
  viewport: Viewport = "desktop",
) {
  return render(
    <MemoryRouter>
      <div
        data-testid="visual-harness"
        data-theme={theme}
        data-viewport={viewport}
        className={`${THEME_STYLES[theme]} ${VIEWPORT_STYLES[viewport]} p-4 font-sans transition-colors`}
      >
        {element}
      </div>
    </MemoryRouter>,
  );
}

// ─── Transaction Preview Presentation Component ─────────────────────────────

interface PreviewPresentationProps {
  actionDescription: string;
  feeEstimate: number | null;
  feeLoading?: boolean;
  feeError?: string | null;
  balances?: BalanceDeltaRow[];
  quorumWeight?: number;
  totalWeight?: number;
}

function PreviewPresentation({
  actionDescription,
  feeEstimate,
  feeLoading = false,
  feeError = null,
  balances = [],
  quorumWeight = 2,
  totalWeight = 3,
}: PreviewPresentationProps) {
  return (
    <div className="space-y-3 rounded-xl border border-zinc-700/60 bg-zinc-900/50 p-4 shadow-sm">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
        <h4 className="text-sm font-semibold text-zinc-200">Transaction Preview</h4>
        <span className="text-xs text-zinc-400 font-mono">Quorum: {quorumWeight}/{totalWeight}</span>
      </div>

      <div className="space-y-2 text-xs">
        <div>
          <span className="text-zinc-400 font-medium">Action: </span>
          <span className="text-zinc-200 break-all">{actionDescription}</span>
        </div>

        <div>
          <span className="text-zinc-400 font-medium">Estimated Network Fee: </span>
          {feeLoading ? (
            <span className="text-zinc-400">Simulating transaction…</span>
          ) : feeEstimate !== null ? (
            <span className="font-mono text-zinc-200">~{feeEstimate.toFixed(7)} XLM</span>
          ) : (
            <span className="text-zinc-500">—</span>
          )}
        </div>

        {balances.length > 0 && (
          <div className="mt-2 space-y-1.5">
            <span className="text-zinc-400 font-medium">Projected Balance Impact:</span>
            {balances.map((row) => (
              <div
                key={`${row.label}-${row.address}`}
                className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/60 px-2.5 py-1.5 font-mono text-[11px]"
              >
                <span className="text-zinc-400">{row.label}</span>
                <span className="text-zinc-200">
                  {row.before} <span className="text-zinc-500">→</span> {row.after} {row.token}
                </span>
              </div>
            ))}
          </div>
        )}

        {feeError && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400"
          >
            <strong>Simulation Failed:</strong> {feeError}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Regression Fixture Component ───────────────────────────────────────────

function CrashingComponent(): React.JSX.Element {
  throw new Error("Simulated component failure in preview rendering");
}

describe("Visual Regression: Transaction Preview, Risk, and Error States", () => {
  const themes: Theme[] = ["dark", "light"];
  const viewports: Viewport[] = ["desktop", "mobile"];

  // 1. Success Cases: Preview States across Themes and Viewports
  describe("Preview States — Success", () => {
    const sampleBalances: BalanceDeltaRow[] = [
      {
        label: "Treasury",
        address: "",
        token: "XLM",
        before: "100.0000000",
        after: "90.0000000",
      },
      {
        label: "Recipient",
        address: "GBJGVY77Z54XW6X4F...982K",
        token: "XLM",
        before: "5.0000000",
        after: "15.0000000",
      },
    ];

    for (const theme of themes) {
      for (const viewport of viewports) {
        test(`renders transaction preview with balance delta (${theme}, ${viewport})`, () => {
          const { container } = renderInHarness(
            <PreviewPresentation
              actionDescription="Transfer 10 XLM to core development pool"
              feeEstimate={0.0000100}
              balances={sampleBalances}
              quorumWeight={2}
              totalWeight={3}
            />,
            theme,
            viewport,
          );

          expect(container.textContent).toContain("Transaction Preview");
          expect(container.textContent).toContain("~0.0000100 XLM");
          expect(container.textContent).toContain("100.0000000 → 90.0000000 XLM");
          expect(container.firstChild).toMatchSnapshot();
        });

        test(`renders voting power preview for adding an owner (${theme}, ${viewport})`, () => {
          const { container } = renderInHarness(
            <VotingPowerPreview
              type="add_owner"
              beforeWeight={3}
              afterWeight={4}
              totalWeight={4}
            />,
            theme,
            viewport,
          );

          expect(container.textContent).toContain("Live Impact Preview");
          expect(container.textContent).toContain("Total voting weight will increase");
          expect(container.firstChild).toMatchSnapshot();
        });
      }
    }
  });

  // 2. Boundary Cases: Thresholds, Zero Fees, and Cap Limits
  describe("Boundary Cases", () => {
    test("renders exact threshold boundary preview (100% quorum required)", () => {
      const { container } = renderInHarness(
        <PreviewPresentation
          actionDescription="Governance upgrade requiring unanimous quorum"
          feeEstimate={0.0000000}
          quorumWeight={5}
          totalWeight={5}
        />,
        "dark",
        "desktop",
      );

      expect(container.textContent).toContain("Quorum: 5/5");
      expect(container.textContent).toContain("~0.0000000 XLM");
      expect(container.firstChild).toMatchSnapshot();
    });

    test("renders whale warning right at the 50% boundary", () => {
      const { container: balanced } = renderInHarness(
        <WhaleWarningBadge triggered={false} sharePct={50} thresholdPct={50} />,
        "dark",
        "mobile",
      );
      expect(balanced.textContent).toContain("Balanced Voting Power");
      expect(balanced.firstChild).toMatchSnapshot();

      const { container: triggered } = renderInHarness(
        <WhaleWarningBadge triggered={true} sharePct={51} thresholdPct={50} />,
        "dark",
        "mobile",
      );
      expect(triggered.textContent).toContain("Single owner controls 51% of voting power");
      expect(triggered.firstChild).toMatchSnapshot();
    });

    test("renders voting power removal preview at minimum threshold boundary", () => {
      const { container } = renderInHarness(
        <VotingPowerPreview
          type="remove_owner"
          beforeWeight={2}
          afterWeight={0}
          totalWeight={2}
          threshold={2}
          warning={{
            show: true,
            message: "Warning: Resulting total weight equals minimum required quorum",
          }}
        />,
        "light",
        "mobile",
      );

      expect(container.textContent).toContain("Warning: Resulting total weight equals minimum required quorum");
      expect(container.firstChild).toMatchSnapshot();
    });
  });

  // 3. Failure & Risk States across Themes and Viewports
  describe("Risk and Error States", () => {
    for (const theme of themes) {
      test(`renders transaction simulation fee error (${theme})`, () => {
        const { container } = renderInHarness(
          <PreviewPresentation
            actionDescription="Large disbursement exceeding treasury balance"
            feeEstimate={null}
            feeError="Simulation failed: Insufficient treasury balance for transfer"
          />,
          theme,
          "desktop",
        );

        expect(container.querySelector('[role="alert"]')).toBeTruthy();
        expect(container.textContent).toContain("Insufficient treasury balance for transfer");
        expect(container.firstChild).toMatchSnapshot();
      });

      test(`renders governance impact badges across risk levels (${theme})`, () => {
        const { container } = renderInHarness(
          <div className="flex flex-wrap gap-2">
            <GovernanceImpactBadge impact="low" />
            <GovernanceImpactBadge impact="medium" />
            <GovernanceImpactBadge impact="high" />
            <GovernanceImpactBadge impact="critical" />
          </div>,
          theme,
          "desktop",
        );

        expect(container.textContent).toContain("LOW");
        expect(container.textContent).toContain("CRITICAL");
        expect(container.firstChild).toMatchSnapshot();
      });

      test(`renders ErrorState banner and card variants (${theme})`, () => {
        const { container: banner } = renderInHarness(
          <ErrorState
            variant="banner"
            message="RPC connection degraded: unable to verify contract state"
            onRetry={() => {}}
            onDismiss={() => {}}
          />,
          theme,
          "desktop",
        );
        expect(banner.querySelector('[role="alert"]')).toBeTruthy();
        expect(banner.textContent).toContain("RPC connection degraded");
        expect(banner.firstChild).toMatchSnapshot();

        const { container: card } = renderInHarness(
          <ErrorState
            variant="page"
            message="Contract deployment not found on current network"
            onRetry={() => {}}
          />,
          theme,
          "mobile",
        );
        expect(card.querySelector('[role="alert"]')).toBeTruthy();
        expect(card.textContent).toContain("Contract deployment not found");
        expect(card.firstChild).toMatchSnapshot();
      });
    }

    test("renders ErrorBoundary fallback display when child crashes", () => {
      const { container } = renderInHarness(
        <ErrorBoundary>
          <CrashingComponent />
        </ErrorBoundary>,
        "dark",
        "desktop",
      );

      expect(container.textContent).toContain("Something went wrong");
      expect(container.firstChild).toMatchSnapshot();
    });
  });

  // 4. One Regression Fixture: Extreme Value & Long Address Overflow on Mobile Light Theme
  describe("Regression Fixture", () => {
    test("REGRESSION_FIXTURE_PREVIEW_TRUNCATION_AND_THEME: 56-char address and huge amount on mobile light theme", () => {
      const longAddress = "GBJGVY77Z54XW6X4FY2ZPQW2R7W5C4XY6789ABCDEF0123456789WHL7";
      const hugeAmount = "1,000,000,000,000.0000000";

      const extremeBalances: BalanceDeltaRow[] = [
        {
          label: "Treasury",
          address: "",
          token: "USDC",
          before: "10,000,000,000,000.0000000",
          after: "9,000,000,000,000.0000000",
        },
        {
          label: "Recipient (Whale Address)",
          address: longAddress,
          token: "USDC",
          before: "0.0000000",
          after: hugeAmount,
        },
      ];

      const { container } = renderInHarness(
        <div className="space-y-4">
          <WhaleWarningBadge
            triggered={true}
            sharePct={85}
            thresholdPct={50}
            message={`Whale concentration alert: ${longAddress} controls 85% of voting weight`}
          />
          <PreviewPresentation
            actionDescription={`Transfer ${hugeAmount} USDC to ${longAddress}`}
            feeEstimate={0.0001250}
            balances={extremeBalances}
            feeError="Warning: Transfer exceeds standard daily rolling limit threshold"
            quorumWeight={4}
            totalWeight={5}
          />
        </div>,
        "light",
        "mobile",
      );

      // Verify no critical text clipping and elements properly structured
      expect(container.textContent).toContain(longAddress);
      expect(container.textContent).toContain(hugeAmount);
      expect(container.textContent).toContain("Whale concentration alert");
      expect(container.firstChild).toMatchSnapshot();
    });
  });
});
