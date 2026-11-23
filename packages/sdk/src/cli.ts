/**
 * Accord CLI command dispatcher for multisig contract operations.
 * Provides deploy, initialize, propose, approve, execute, and query with
 * machine-readable JSON or human-friendly output.
 */

export interface CliResult {
  success: boolean;
  command: string;
  data?: unknown;
  error?: string;
  output: string;
}

export interface CliOptions {
  json?: boolean;
  contractId?: string;
  rpcUrl?: string;
  network?: string;
}

export function parseCliArgs(argv: string[]): {
  command: string;
  subcommand?: string;
  options: Record<string, string | boolean>;
  positional: string[];
} {
  const options: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        options[key] = val;
      } else {
        const key = arg.slice(2);
        if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
          options[key] = argv[++i];
        } else {
          options[key] = true;
        }
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      options[key] = true;
    } else {
      positional.push(arg);
    }
  }

  const command = positional[0] || "help";
  const subcommand = positional[1];

  return { command, subcommand, options, positional };
}

export const CLI_HELP = `
Accord Protocol CLI

Usage:
  accord <command> [options]

Commands:
  deploy                    Simulate or output contract deployment parameters
  init                      Initialize multisig with owners and threshold
                            --owners=<addr1,addr2> --threshold=<m>
  propose                   Create a new treasury disbursement proposal
                            --to=<recipient> --amount=<amount> --token=<token> --desc=<desc>
  approve                   Approve an existing proposal
                            --id=<proposal_id>
  execute                   Execute an approved proposal
                            --id=<proposal_id>
  query [target]            Query contract state: owners, threshold, proposal, or frozen
                            --id=<proposal_id> (for query proposal)
  help                      Show this help documentation

Options:
  --json                    Emit machine-readable JSON output
  --contract=<id>           Target Soroban contract address
  --rpc=<url>               Soroban RPC URL
  --network=<passphrase>    Network passphrase
`;

/**
 * Executes an Accord CLI command string array and produces structured output.
 */
export async function runCli(argv: string[], executor?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>): Promise<CliResult> {
  const { command, options, positional } = parseCliArgs(argv);
  const isJson = Boolean(options.json);

  if (command === "help" || options.help || options.h) {
    return {
      success: true,
      command: "help",
      data: { help: CLI_HELP },
      output: isJson ? JSON.stringify({ success: true, command: "help" }, null, 2) : CLI_HELP.trim(),
    };
  }

  try {
    let resultData: unknown;

    switch (command) {
      case "deploy": {
        resultData = executor
          ? await executor("deploy", options)
          : { action: "deploy", status: "ready", wasm: "accord.wasm" };
        break;
      }
      case "init":
      case "initialize": {
        const owners = typeof options.owners === "string" ? options.owners.split(",") : [];
        const threshold = Number(options.threshold ?? 1);
        if (!owners.length || isNaN(threshold)) {
          throw new Error("Missing required options --owners and --threshold");
        }
        resultData = executor
          ? await executor("init", { owners, threshold, ...options })
          : { action: "initialize", owners, threshold, status: "initialized" };
        break;
      }
      case "propose": {
        const to = String(options.to || "");
        const amount = String(options.amount || "0");
        const token = String(options.token || "XLM");
        const description = String(options.desc || options.description || "");
        if (!to) throw new Error("Missing required option --to");
        resultData = executor
          ? await executor("propose", { to, amount, token, description, ...options })
          : { action: "propose", proposalId: 1, to, amount, token, status: "pending" };
        break;
      }
      case "approve": {
        const id = Number(options.id || positional[1]);
        if (!id || isNaN(id)) throw new Error("Missing required proposal ID (--id=<number>)");
        resultData = executor
          ? await executor("approve", { proposalId: id, ...options })
          : { action: "approve", proposalId: id, approved: true };
        break;
      }
      case "execute": {
        const id = Number(options.id || positional[1]);
        if (!id || isNaN(id)) throw new Error("Missing required proposal ID (--id=<number>)");
        resultData = executor
          ? await executor("execute", { proposalId: id, ...options })
          : { action: "execute", proposalId: id, executed: true };
        break;
      }
      case "query": {
        const target = positional[1] || "all";
        const id = options.id ? Number(options.id) : undefined;
        resultData = executor
          ? await executor("query", { target, id, ...options })
          : { action: "query", target, id, result: "ok" };
        break;
      }
      default:
        throw new Error(`Unknown command: '${command}'. Run 'accord help' for available commands.`);
    }

    const output = isJson
      ? JSON.stringify({ success: true, command, data: resultData }, null, 2)
      : `[OK] Command '${command}' completed successfully:\n` + JSON.stringify(resultData, null, 2);

    return {
      success: true,
      command,
      data: resultData,
      output,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const output = isJson
      ? JSON.stringify({ success: false, command, error: errorMsg }, null, 2)
      : `[ERROR] ${errorMsg}`;

    return {
      success: false,
      command,
      error: errorMsg,
      output,
    };
  }
}
