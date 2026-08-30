import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { signTx } from "./wallet";

const RPC_URL = (import.meta.env.VITE_SOROBAN_RPC_URL as string) || "https://soroban-testnet.stellar.org";
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ADDRESS as string;
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE as string;

const server = new rpc.Server(RPC_URL);

async function buildAndSubmit(
  callerAddress: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<void> {
  // 1. Load caller's account for sequence number
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  // 2. Simulate to get auth entries + resource estimates
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${err.error ?? "unknown"}`);
  }

  // 3. Assemble — injects auth entries and resource fee
  const assembled = rpc.assembleTransaction(tx, sim).build();

  // 4. Sign via Freighter
  const signed = await signTx(assembled.toXDR());
  if (!signed.ok) throw new Error(signed.error);

  // 5. Submit
  const sent = await server.sendTransaction(
    TransactionBuilder.fromXDR(signed.value, NETWORK_PASSPHRASE)
  );

  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  // 6. Poll until confirmed (or 30s timeout)
  const hash = sent.hash;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return;
    if (res.status === "FAILED") {
      throw new Error(`Transaction failed on-chain`);
    }
  }
  throw new Error("Transaction not confirmed within 30s");
}

async function simulateOnly(
  callerAddress: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<number> {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${err.error ?? "unknown"}`);
  }

  const minResourceFee = BigInt(sim.minResourceFee);
  const baseFee = 100000n;
  const totalStroops = baseFee + minResourceFee;
  return Number(totalStroops) / 10_000_000;
}

// ─── Public contract write functions ─────────────────────────────────────────
// Function names must match the Rust contract exactly.

export async function approveProposal(
  callerAddress: string,
  proposalId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "approve", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
}

export async function executeProposal(
  callerAddress: string,
  proposalId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "execute", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
}

export async function revokeProposal(
  callerAddress: string,
  proposalId: number
): Promise<void> {
  await buildAndSubmit(callerAddress, "revoke", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(BigInt(proposalId), { type: "u64" }),
  ]);
}

export async function createProposal(
  callerAddress: string,
  to: string,
  tokenAddress: string,
  amount: bigint,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  // Contract signature: create_proposal(proposer, to, amount, token, description, deadline)
  await buildAndSubmit(callerAddress, "create_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),  // proposer
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createSpendingLimitProposal(
  callerAddress: string,
  owner: string,
  tokenAddress: string,
  amount: bigint,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_set_spending_limit_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(owner, { type: "address" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

// ─── Guardian / emergency pause ─────────────────────────────────────────────

export async function freeze(
  callerAddress: string
): Promise<void> {
  await buildAndSubmit(callerAddress, "freeze", [
    nativeToScVal(callerAddress, { type: "address" }),
  ]);
}

export async function createSetGuardianProposal(
  callerAddress: string,
  newGuardian: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_set_guardian_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(newGuardian, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createUnfreezeProposal(
  callerAddress: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_unfreeze_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

// ─── Co-signature helpers ────────────────────────────────────────────────────

export async function buildAndAssembleTx(
  callerAddress: string,
  fn: string,
  args: xdr.ScVal[]
): Promise<string> {
  const account = await server.getAccount(callerAddress);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`Simulation failed: ${err.error ?? "unknown"}`);
  }

  const assembled = rpc.assembleTransaction(tx, sim).build();
  return assembled.toXDR();
}

export async function signAndSubmitMultiSig(
  xdrStr: string,
  networkPassphrase?: string
): Promise<void> {
  const passphrase = networkPassphrase ?? NETWORK_PASSPHRASE;
  const signed = await signTx(xdrStr, passphrase.includes("Public") ? "PUBLIC" : "TESTNET");
  if (!signed.ok) throw new Error(signed.error);

  const tx = TransactionBuilder.fromXDR(signed.value, passphrase);
  const sent = await server.sendTransaction(tx);

  if (sent.status === "ERROR") {
    throw new Error(`Submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  const hash = sent.hash;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") return;
    if (res.status === "FAILED") {
      throw new Error(`Transaction failed on-chain`);
    }
  }
  throw new Error("Transaction not confirmed within 60s");
}

export async function estimateCreateProposalFee(
  callerAddress: string,
  to: string,
  tokenAddress: string,
  amount: bigint,
  description: string,
  deadlineTs: bigint
): Promise<number> {
  return await simulateOnly(callerAddress, "create_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),  // proposer
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
    nativeToScVal(tokenAddress, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

// ─── Governance proposal creation ────────────────────────────────────────────

export async function createAddOwnerProposal(
  callerAddress: string,
  newOwner: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_add_owner_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(newOwner, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createRemoveOwnerProposal(
  callerAddress: string,
  ownerToRemove: string,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_remove_owner_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(ownerToRemove, { type: "address" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createChangeThresholdProposal(
  callerAddress: string,
  newThreshold: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_change_threshold_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(newThreshold, { type: "u32" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}

export async function createChangeOwnerWeightProposal(
  callerAddress: string,
  targetOwner: string,
  newWeight: number,
  description: string,
  deadlineTs: bigint
): Promise<void> {
  await buildAndSubmit(callerAddress, "create_change_weight_proposal", [
    nativeToScVal(callerAddress, { type: "address" }),
    nativeToScVal(targetOwner, { type: "address" }),
    nativeToScVal(newWeight, { type: "u32" }),
    xdr.ScVal.scvString(description),
    nativeToScVal(deadlineTs, { type: "u64" }),
  ]);
}
