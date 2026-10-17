import { waitFor } from "@testing-library/react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { describe, expect, test } from "vitest";
import { renderStory } from "./renderStory";

import AnalyticsSectionMeta, * as AnalyticsSectionStories from "../components/AnalyticsSectionState.stories";
import ApprovalBarMeta, * as ApprovalBarStories from "../components/ApprovalBar.stories";
import CreateProposalModalMeta, * as CreateProposalModalStories from "../components/CreateProposalModal.stories";
import CreateRecurringPaymentModalMeta, * as CreateRecurringPaymentModalStories from "../components/CreateRecurringPaymentModal.stories";
import CreateWeightChangeProposalModalMeta, * as CreateWeightChangeProposalModalStories from "../components/CreateWeightChangeProposalModal.stories";
import DelegateModalMeta, * as DelegateModalStories from "../components/DelegateModal.stories";
import EmptyStateMeta, * as EmptyStateStories from "../components/EmptyState.stories";
import ErrorStateMeta, * as ErrorStateStories from "../components/ErrorState.stories";
import GovernanceHealthMeta, * as GovernanceHealthStories from "../components/GovernanceHealthWidget.stories";
import GovernanceImpactMeta, * as GovernanceImpactStories from "../components/GovernanceImpactBadge.stories";
import GlobalSearchMeta, * as GlobalSearchStories from "../components/GlobalSearch.stories";
import GrantRevokeRoleModalMeta, * as GrantRevokeRoleModalStories from "../components/GrantRevokeRoleModal.stories";
import HistoricalWeightChartMeta, * as HistoricalWeightChartStories from "../components/HistoricalWeightChart.stories";
import LoadingStateMeta, * as LoadingStateStories from "../components/LoadingState.stories";
import ProposalActivityChartMeta, * as ProposalActivityChartStories from "../components/ProposalActivityChart.stories";
import ProposalCardMeta, * as ProposalCardStories from "../components/ProposalCard.stories";
import ProposalCardSkeletonMeta, * as ProposalCardSkeletonStories from "../components/ProposalCardSkeleton.stories";
import RecurringPaymentActionModalsMeta, * as RecurringPaymentActionModalsStories from "../components/RecurringPaymentActionModals.stories";
import RecurringPaymentCardMeta, * as RecurringPaymentCardStories from "../components/RecurringPaymentCard.stories";
import RoleModalMeta, * as RoleModalStories from "../components/RoleModal.stories";
import SpendByCategoryChartMeta, * as SpendByCategoryChartStories from "../components/SpendByCategoryChart.stories";
import SpendByOwnerChartMeta, * as SpendByOwnerChartStories from "../components/SpendByOwnerChart.stories";
import StatCardMeta, * as StatCardStories from "../components/StatCard.stories";
import StatusBadgeMeta, * as StatusBadgeStories from "../components/StatusBadge.stories";
import TreasuryBalanceChartMeta, * as TreasuryBalanceChartStories from "../components/TreasuryBalanceChart.stories";
import TreasuryFlowChartMeta, * as TreasuryFlowChartStories from "../components/TreasuryFlowChart.stories";
import VotingPowerPreviewMeta, * as VotingPowerPreviewStories from "../components/VotingPowerPreview.stories";
import WhaleWarningBadgeMeta, * as WhaleWarningBadgeStories from "../components/WhaleWarningBadge.stories";
import ErrorBoundaryMeta, * as ErrorBoundaryStories from "../components/ErrorBoundary.stories";

type StoryModule = Record<string, unknown>;

function storyEntries(meta: Meta<unknown>, mod: StoryModule) {
  return Object.entries(mod)
    .filter(([name]) => name !== "default")
    .map(([name, story]) => ({
      id: name,
      meta,
      story: story as StoryObj<unknown>,
    }));
}

const groups: Array<{ label: string; meta: Meta<unknown>; mod: StoryModule }> = [
  { label: "AnalyticsSectionState", meta: AnalyticsSectionMeta, mod: AnalyticsSectionStories },
  { label: "ApprovalBar", meta: ApprovalBarMeta, mod: ApprovalBarStories },
  { label: "CreateProposalModal", meta: CreateProposalModalMeta, mod: CreateProposalModalStories },
  { label: "CreateRecurringPaymentModal", meta: CreateRecurringPaymentModalMeta, mod: CreateRecurringPaymentModalStories },
  { label: "CreateWeightChangeProposalModal", meta: CreateWeightChangeProposalModalMeta, mod: CreateWeightChangeProposalModalStories },
  { label: "DelegateModal", meta: DelegateModalMeta, mod: DelegateModalStories },
  { label: "EmptyState", meta: EmptyStateMeta, mod: EmptyStateStories },
  { label: "ErrorState", meta: ErrorStateMeta, mod: ErrorStateStories },
  { label: "ErrorBoundary", meta: ErrorBoundaryMeta, mod: ErrorBoundaryStories },
  { label: "GlobalSearch", meta: GlobalSearchMeta, mod: GlobalSearchStories },
  { label: "GovernanceHealthWidget", meta: GovernanceHealthMeta, mod: GovernanceHealthStories },
  { label: "GovernanceImpactBadge", meta: GovernanceImpactMeta, mod: GovernanceImpactStories },
  { label: "GrantRevokeRoleModal", meta: GrantRevokeRoleModalMeta, mod: GrantRevokeRoleModalStories },
  { label: "HistoricalWeightChart", meta: HistoricalWeightChartMeta, mod: HistoricalWeightChartStories },
  { label: "LoadingState", meta: LoadingStateMeta, mod: LoadingStateStories },
  { label: "ProposalActivityChart", meta: ProposalActivityChartMeta, mod: ProposalActivityChartStories },
  { label: "ProposalCard", meta: ProposalCardMeta, mod: ProposalCardStories },
  { label: "ProposalCardSkeleton", meta: ProposalCardSkeletonMeta, mod: ProposalCardSkeletonStories },
  { label: "RecurringPaymentActionModals", meta: RecurringPaymentActionModalsMeta, mod: RecurringPaymentActionModalsStories },
  { label: "RecurringPaymentCard", meta: RecurringPaymentCardMeta, mod: RecurringPaymentCardStories },
  { label: "RoleModal", meta: RoleModalMeta, mod: RoleModalStories },
  { label: "SpendByCategoryChart", meta: SpendByCategoryChartMeta, mod: SpendByCategoryChartStories },
  { label: "SpendByOwnerChart", meta: SpendByOwnerChartMeta, mod: SpendByOwnerChartStories },
  { label: "StatCard", meta: StatCardMeta, mod: StatCardStories },
  { label: "StatusBadge", meta: StatusBadgeMeta, mod: StatusBadgeStories },
  { label: "TreasuryBalanceChart", meta: TreasuryBalanceChartMeta, mod: TreasuryBalanceChartStories },
  { label: "TreasuryFlowChart", meta: TreasuryFlowChartMeta, mod: TreasuryFlowChartStories },
  { label: "VotingPowerPreview", meta: VotingPowerPreviewMeta, mod: VotingPowerPreviewStories },
  { label: "WhaleWarningBadge", meta: WhaleWarningBadgeMeta, mod: WhaleWarningBadgeStories },
];

describe("component story visual snapshots", () => {
  for (const { label, meta, mod } of groups) {
    for (const { id, meta: storyMeta, story } of storyEntries(meta, mod)) {
      if (label === "ErrorBoundary" && id === "Fallback") {
        continue;
      }

      test(`${label} / ${id}`, async () => {
        const { container } = renderStory(storyMeta, story);

        if (label === "HistoricalWeightChart" && id === "WithHistory") {
          await waitFor(() => {
            expect(container.querySelector(".recharts-wrapper")).toBeTruthy();
          });
        }

        expect(container.firstChild).toMatchSnapshot();
      });
    }
  }
});
