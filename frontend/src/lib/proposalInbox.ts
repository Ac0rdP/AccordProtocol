import {
  getOwners,
  getProposalsPaged,
  getRoles,
  getThreshold,
  getTotalProposals,
  hasApproved,
  mapProposal,
} from "./contract";
import { canApprove, canExecute } from "./soroban";
import type { Proposal } from "../types/accord";
import type { ProposalWorkspace } from "./proposalWorkspaces";

export type ProposalInboxEntry = {
  workspace: ProposalWorkspace;
  proposal: Proposal;
  history: Proposal[];
};

export async function getWorkspaceInbox(
  workspace: ProposalWorkspace,
  walletAddress: string,
): Promise<ProposalInboxEntry[]> {
  const [total, threshold, owners] = await Promise.all([
    getTotalProposals(workspace.contractId),
    getThreshold(workspace.contractId),
    getOwners(workspace.contractId),
  ]);
  const roles = await getRoles(walletAddress, owners, workspace.contractId);

  const rawProposals: unknown[] = [];
  for (let offset = 0; offset < total; offset += 20) {
    rawProposals.push(
      ...await getProposalsPaged(offset, 20, workspace.contractId),
    );
  }
  const proposals = rawProposals.map((raw) => mapProposal(raw, threshold));
  const actionable = proposals.filter((proposal) =>
    (proposal.status === "pending" && canApprove(roles)) ||
    (proposal.status === "ready" && canExecute(roles)),
  );
  const inboxEntries: ProposalInboxEntry[] = [];
  for (let offset = 0; offset < actionable.length; offset += 20) {
    const page = actionable.slice(offset, offset + 20);
    const approvalStates = await Promise.all(
      page.map((proposal) =>
        proposal.status === "pending"
          ? hasApproved(walletAddress, proposal.id, workspace.contractId)
          : Promise.resolve(false),
      ),
    );

    page.forEach((proposal, index) => {
      const userHasApproved = approvalStates[index];
      const needsApproval = proposal.status === "pending" && !userHasApproved;
      const needsExecution = proposal.status === "ready" && canExecute(roles);

      if (needsApproval || needsExecution) {
        inboxEntries.push({
          workspace,
          proposal: { ...proposal, userHasApproved },
          history: proposals,
        });
      }
    });
  }
  return inboxEntries;
}
