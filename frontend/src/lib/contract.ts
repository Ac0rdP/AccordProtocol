import {
  Contract,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  Delegation,
  OwnerDelegations,
  Proposal,
  ProposalCategory,
  ProposalEvent,
  ProposalEventType,
  ProposalKind,
  ProposalStatus,
  RecurringSchedule,
  RecurringScheduleStatus,
  RecurringKind,
  RecurringPayment,
  RecurringStatus,
} from "../types/accord";
import { stroopsToDisplay, formatDeadline, shortenAddr, formatInterval } from "./soroban";

const RPC_URL = import.meta.env.VITE_SOROBAN_RPC_URL as string;
const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ADDRESS as string;
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE as string;
// Any funded testnet account - used only to build simulation transactions (no signing).
const SIM_SOURCE = import.meta.env.VITE_SIM_SOURCE as string;

const server = new rpc.Server(RPC_URL);

async function simulateView(
  fn: string,
  args: xdr.ScVal[] = []
): Promise<xdr.ScVal> {
  const account = await server.getAccount(SIM_SOURCE);
  const contract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
   .addOperation(contract.call(fn,...args))
   .setTimeout(30)
   .build();

  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    const err = sim as rpc.Api.SimulateTransactionErrorResponse;
    throw new Error(`${fn}: ${err.error?? "simulation failed"}`);
  }
  return (sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval;
}

function mapStatus(raw: unknown): ProposalStatus {
  if (typeof raw === "string") return raw.toLowerCase() as ProposalStatus;
  if (raw && typeof raw === "object") {
    const key = Object.keys(raw as object)[0]?? "Pending";
    return key.toLowerCase() as ProposalStatus;
  }
  return "pending";
}

function mapCategory(raw: unknown): ProposalCategory {
  let key: string;
  if (typeof raw === "string") {
    key = raw;
  } else if (raw && typeof raw === "object") {
    key = Object.keys(raw as object)[0]?? "Other";
  } else {
    return "other";
  }
  switch (key.toLowerCase()) {
    case "transfer":
      return "transfer";
    case "payroll":
      return "payroll";
    case "grant":
      return "grant";
    case "ops":
      return "ops";
    default:
      return "other";
  }
}

function safeBigInt(value: unknown): bigint {
  try {
    if (
      typeof value === "bigint" ||
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return BigInt(value);
    }
    return 0n;
  } catch {
    return 0n;
  }
}

function mapKindDetails(
  kind: unknown
): Pick<Proposal, "kind" | "to" | "amount" | "rawAmount" | "token"> {
  if (!kind || typeof kind!== "object") {
    return {
      kind: "transfer",
      to: "Unknown",
      amount: "0",
      rawAmount: "0",
      token: "Unknown",
    };
  }

  const [variant, payload] = Object.entries(kind as Record<string, unknown>)[0]?? [];
  const normalizedVariant = variant?.toLowerCase()?? "";
  const values = Array.isArray(payload)? payload : [payload];
  const raw = safeBigInt(values[1]);

  switch (normalizedVariant) {
    case "transfer":
      return {
        kind: "transfer",
        to: shortenAddr(String(values[0]?? "Unknown")),
        amount: stroopsToDisplay(raw),
        rawAmount: String(raw),
        token: shortenAddr(String(values[2]?? "Unknown")),
      };
    case "addowner":
      return {
        kind: "add_owner",
        to: shortenAddr(String(values[0]?? "Unknown")),
        amount: "-",
        rawAmount: "-",
        token: "Add owner",
      };
    case "removeowner":
      return {
        kind: "remove_owner",
        to: shortenAddr(String(values[0]?? "Unknown")),
        amount: "-",
        rawAmount: "-",
        token: "Remove owner",
      };
    case "changethreshold":
      return {
        kind: "change_threshold",
        to: `${values[0]?? "Unknown"} approvals`,
        amount: "-",
        rawAmount: "-",
        token: "Threshold",
      };
    case "setspendinglimit":
      return {
        kind: "set_spending_limit",
        to: shortenAddr(String(values[0]?? "Unknown")),
        amount: String(values[2]?? "Unknown"),
        rawAmount: String(values[2]?? "0"),
        token: shortenAddr(String(values[1]?? "Unknown")),
      };
    case "changeownerweight":
      return {
        kind: "change_owner_weight",
        to: shortenAddr(String(values[0]?? "Unknown")),
        amount: String(values[1]?? "Unknown"),
        rawAmount: String(values[1]?? "0"),
        token: "Owner weight",
      };
    default:
      return {
        kind: "transfer",
        to: "Unknown",
        amount: "0",
        rawAmount: "0",
        token: "Unknown",
      };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
