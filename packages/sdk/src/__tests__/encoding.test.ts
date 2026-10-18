import { describe, expect, it } from "vitest";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  addressToScVal,
  bytes32ToScVal,
  categoryToScVal,
  createRecurringParamsToScVal,
  i128ToScVal,
  roleToScVal,
  scValToBigInt,
  scValToDelegationInfo,
  scValToNumber,
  scValToProposal,
  scValToRecurringPayment,
  scValToSpentTracker,
  transfersToScVal,
  u32ToScVal,
  u64ToScVal,
} from "../conversion.js";
import type { CreateRecurringParams, Transfer } from "../types.js";

describe("SDK XDR Encoding and Decoding", () => {
  const accountAddr = "GD5JDFYKNL23W2CQOXW6V57JMGDUQMK2M27B2L67MQK7Y65J42B67I7J";
  const tokenAddr = "CD4YAMHZETIO3GTHP4JB3SF2LQFQMZ6MW5FUNCTMXYGOVN6AAXDBQKJS";

  it("encodes and decodes 64-bit integers preserving bigint precision", () => {
    const val = 1800000000123456789n;
    const scVal = u64ToScVal(val);
    expect(scVal.switch()).toBe(xdr.ScValType.scvU64());
    const decoded = scValToBigInt(scVal);
    expect(decoded).toBe(val);
  });

  it("encodes and decodes 128-bit integers preserving bigint precision", () => {
    const largeAmount = 5000000000000000000000000n; // 5 * 10^24
    const scVal = i128ToScVal(largeAmount);
    expect(scVal.switch()).toBe(xdr.ScValType.scvI128());
    const decoded = scValToBigInt(scVal);
    expect(decoded).toBe(largeAmount);
  });

  it("encodes address to ScVal Address", () => {
    const scVal = addressToScVal(accountAddr);
    expect(scVal.switch()).toBe(xdr.ScValType.scvAddress());
  });

  it("encodes 32-byte hex hash to ScVal Bytes", () => {
    const hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const scVal = bytes32ToScVal(hex);
    expect(scVal.switch()).toBe(xdr.ScValType.scvBytes());
    expect(scVal.bytes()?.length).toBe(32);
  });

  it("encodes Transfers array to ScVal Vec of Maps", () => {
    const transfers: Transfer[] = [
      { to: accountAddr, token: tokenAddr, amount: 10000000n },
    ];
    const scVal = transfersToScVal(transfers);
    expect(scVal.switch()).toBe(xdr.ScValType.scvVec());
    expect(scVal.vec()?.length).toBe(1);
  });

  it("decodes raw ScVal proposal struct into typed Proposal record", () => {
    const proposalMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("id"), val: u64ToScVal(1n) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("proposer"), val: addressToScVal(accountAddr) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("description"), val: xdr.ScVal.scvString("Test Proposal") }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("deadline"), val: u64ToScVal(1700000000n) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("approvals"), val: u32ToScVal(2) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("approval_weight"), val: u32ToScVal(2) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("status"), val: xdr.ScVal.scvSymbol("Ready") }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("ready_at"), val: u64ToScVal(1690000000n) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("quorum_weight"), val: u32ToScVal(2) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("category"), val: xdr.ScVal.scvSymbol("Transfer") }),
    ]);

    const proposal = scValToProposal(proposalMap);
    expect(proposal.id).toBe(1n);
    expect(proposal.proposer).toBe(accountAddr);
    expect(proposal.description).toBe("Test Proposal");
    expect(proposal.deadline).toBe(1700000000n);
    expect(proposal.approvals).toBe(2);
    expect(proposal.status).toBe("Ready");
    expect(proposal.category).toBe("Transfer");
  });

  it("decodes spent tracker struct", () => {
    const trackerMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("spent"), val: i128ToScVal(5000000n) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("epoch"), val: u64ToScVal(1690000000n) }),
    ]);

    const tracker = scValToSpentTracker(trackerMap);
    expect(tracker.spent).toBe(5000000n);
    expect(tracker.epoch).toBe(1690000000n);
  });
});
