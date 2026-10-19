import React, { useEffect, useState } from "react";
import {
  AccordContractError,
  AccordValidationError,
  ContractError,
  type Proposal,
} from "@accord-protocol/sdk";
import { checkFreighterInstalled, connectFreighter } from "./wallet.js";
import { createAccordClient } from "./sdk-client.js";

export function App(): React.JSX.Element {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isFreighterAvailable, setIsFreighterAvailable] = useState<boolean>(false);
  const [owners, setOwners] = useState<string[]>([]);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [isFrozen, setIsFrozen] = useState<boolean>(false);
  const [isInRecovery, setIsInRecovery] = useState<boolean>(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);

  // Form state
  const [recipient, setRecipient] = useState<string>("");
  const [tokenAddress, setTokenAddress] = useState<string>("");
  const [amountStroops, setAmountStroops] = useState<string>("10000000"); // 1 XLM / USDC
  const [description, setDescription] = useState<string>("Grant distribution");

  // Interaction feedback states
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    checkFreighterInstalled().then(setIsFreighterAvailable);
    loadContractState();
  }, []);

  async function loadContractState() {
    try {
      const client = createAccordClient();
      const [fetchedOwners, fetchedThreshold, fetchedFrozen, fetchedRecovery, fetchedProposals] =
        await Promise.all([
          client.getOwners(),
          client.getThreshold(),
          client.isFrozen(),
          client.isInRecovery(),
          client.getProposalsPaged(0n, 10),
        ]);

      setOwners(fetchedOwners);
      setThreshold(fetchedThreshold);
      setIsFrozen(fetchedFrozen);
      setIsInRecovery(fetchedRecovery);
      setProposals(fetchedProposals);
    } catch (err: unknown) {
      handleError("Load Contract State", err);
    }
  }

  async function handleConnectWallet() {
    setActionError(null);
    try {
      const addr = await connectFreighter();
      setWalletAddress(addr);
      setActionStatus(`Wallet connected: ${addr}`);
    } catch (err: unknown) {
      handleError("Connect Wallet", err);
    }
  }

  async function handleCreateProposal(e: React.FormEvent) {
    e.preventDefault();
    if (!walletAddress) {
      setActionError("Please connect your Freighter wallet first.");
      return;
    }

    setIsLoading(true);
    setActionStatus("Preparing and simulating proposal...");
    setActionError(null);

    try {
      const client = createAccordClient(walletAddress);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 86400 * 7); // 7 days

      const txHash = await client.createProposal(
        walletAddress,
        [
          {
            to: recipient,
            token: tokenAddress,
            amount: BigInt(amountStroops),
          },
        ],
        description,
        deadline,
        "Transfer"
      );

      setActionStatus(`Proposal successfully created! Tx Hash: ${txHash}`);
      await loadContractState();
    } catch (err: unknown) {
      handleError("Create Proposal", err);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleApprove(proposalId: bigint) {
    if (!walletAddress) {
      setActionError("Please connect wallet first.");
      return;
    }

    setIsLoading(true);
    setActionStatus(`Approving proposal #${proposalId}...`);
    setActionError(null);

    try {
      const client = createAccordClient(walletAddress);
      const txHash = await client.approve(walletAddress, proposalId);
      setActionStatus(`Proposal #${proposalId} approved! Tx Hash: ${txHash}`);
      await loadContractState();
    } catch (err: unknown) {
      handleError("Approve Proposal", err);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleExecute(proposalId: bigint) {
    if (!walletAddress) {
      setActionError("Please connect wallet first.");
      return;
    }

    setIsLoading(true);
    setActionStatus(`Executing proposal #${proposalId}...`);
    setActionError(null);

    try {
      const client = createAccordClient(walletAddress);
      const txHash = await client.execute(walletAddress, proposalId);
      setActionStatus(`Proposal #${proposalId} executed! Tx Hash: ${txHash}`);
      await loadContractState();
    } catch (err: unknown) {
      handleError("Execute Proposal", err);
    } finally {
      setIsLoading(false);
    }
  }

  function handleError(context: string, err: unknown) {
    if (err instanceof AccordContractError) {
      if (err.errorCode === ContractError.RecoveryActive) {
        setActionError(`[${context}] Action blocked: Treasury is currently in recovery mode.`);
      } else if (err.errorCode === ContractError.ContractFrozen) {
        setActionError(`[${context}] Action blocked: Contract is currently frozen by the guardian.`);
      } else if (err.errorCode === ContractError.ThresholdNotMet) {
        setActionError(`[${context}] Cannot execute: Approval threshold has not been reached.`);
      } else {
        setActionError(`[${context}] Contract Error: ${err.message}`);
      }
    } else if (err instanceof AccordValidationError) {
      setActionError(`[${context}] Client Validation Error: ${err.message}`);
    } else {
      setActionError(`[${context}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div style={{ maxWidth: 800, margin: "40px auto", fontFamily: "sans-serif", padding: 20 }}>
      <h1>Accord Protocol — Multisig dApp Example</h1>
      <p>Demonstrating end-to-end integration with <code>@accord-protocol/sdk</code>.</p>

      {/* Wallet Connection */}
      <div style={{ background: "#f5f5f5", padding: 15, borderRadius: 8, marginBottom: 20 }}>
        <h3>Wallet Status</h3>
        {!isFreighterAvailable && (
          <p style={{ color: "#d97706" }}>
            Freighter extension not detected. Please install Freighter from freighter.app to submit transactions.
          </p>
        )}
        {walletAddress ? (
          <div>
            <p>Connected Address: <strong>{walletAddress}</strong></p>
          </div>
        ) : (
          <button onClick={handleConnectWallet} style={{ padding: "8px 16px", cursor: "pointer" }}>
            Connect Freighter Wallet
          </button>
        )}
      </div>

      {/* Contract State */}
      <div style={{ background: "#eef2ff", padding: 15, borderRadius: 8, marginBottom: 20 }}>
        <h3>Contract State</h3>
        <p>Threshold: <strong>{threshold ?? "-"}</strong> / Total Owners: <strong>{owners.length}</strong></p>
        <p>Frozen: <strong>{isFrozen ? "YES (Blocked)" : "NO (Active)"}</strong> | In Recovery: <strong>{isInRecovery ? "YES (Outflows Locked)" : "NO"}</strong></p>
        <details>
          <summary>View Registered Owners ({owners.length})</summary>
          <ul>
            {owners.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
        </details>
      </div>

      {/* Notifications */}
      {actionStatus && (
        <div style={{ background: "#ecfdf5", color: "#065f46", padding: 12, borderRadius: 6, marginBottom: 15 }}>
          {actionStatus}
        </div>
      )}
      {actionError && (
        <div style={{ background: "#fef2f2", color: "#991b1b", padding: 12, borderRadius: 6, marginBottom: 15 }}>
          {actionError}
        </div>
      )}

      {/* Create Proposal Form */}
      <div style={{ border: "1px solid #e5e7eb", padding: 20, borderRadius: 8, marginBottom: 25 }}>
        <h3>Create Transfer Proposal</h3>
        <form onSubmit={handleCreateProposal}>
          <div style={{ marginBottom: 10 }}>
            <label>Recipient Address (G...):</label><br />
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="G..."
              required
              style={{ width: "100%", padding: 8 }}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label>Token Contract Address (C...):</label><br />
            <input
              type="text"
              value={tokenAddress}
              onChange={(e) => setTokenAddress(e.target.value)}
              placeholder="C..."
              required
              style={{ width: "100%", padding: 8 }}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label>Amount (in stroops / smallest units):</label><br />
            <input
              type="text"
              value={amountStroops}
              onChange={(e) => setAmountStroops(e.target.value)}
              required
              style={{ width: "100%", padding: 8 }}
            />
          </div>
          <div style={{ marginBottom: 15 }}>
            <label>Description:</label><br />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              style={{ width: "100%", padding: 8 }}
            />
          </div>
          <button
            type="submit"
            disabled={isLoading || !walletAddress}
            style={{ padding: "10px 20px", background: "#2563eb", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
          >
            {isLoading ? "Submitting..." : "Submit Proposal"}
          </button>
        </form>
      </div>

      {/* Proposals List */}
      <div>
        <h3>Proposals ({proposals.length})</h3>
        {proposals.length === 0 ? (
          <p>No proposals found on this contract.</p>
        ) : (
          proposals.map((p) => (
            <div key={p.id.toString()} style={{ border: "1px solid #ddd", padding: 15, borderRadius: 6, marginBottom: 10 }}>
              <h4>Proposal #{p.id.toString()}: {p.description}</h4>
              <p>Status: <strong>{p.status}</strong> | Approvals: <strong>{p.approvals}</strong> / Quorum: <strong>{p.quorum_weight}</strong></p>
              <div style={{ display: "flex", gap: 10 }}>
                {p.status === "Pending" && (
                  <button
                    onClick={() => handleApprove(p.id)}
                    disabled={isLoading || !walletAddress}
                    style={{ padding: "6px 12px", cursor: "pointer" }}
                  >
                    Approve
                  </button>
                )}
                {p.status === "Ready" && (
                  <button
                    onClick={() => handleExecute(p.id)}
                    disabled={isLoading || !walletAddress}
                    style={{ padding: "6px 12px", background: "#059669", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
                  >
                    Execute
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
