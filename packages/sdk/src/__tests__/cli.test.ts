import { describe, expect, it } from "vitest";
import { parseCliArgs, runCli } from "../cli.js";

describe("CLI argument parsing", () => {
  it("parses commands and flag arguments", () => {
    const parsed = parseCliArgs([
      "propose",
      "--to=GA123",
      "--amount",
      "500",
      "--token=USDC",
      "--json",
    ]);

    expect(parsed.command).toBe("propose");
    expect(parsed.options.to).toBe("GA123");
    expect(parsed.options.amount).toBe("500");
    expect(parsed.options.token).toBe("USDC");
    expect(parsed.options.json).toBe(true);
  });
});

describe("runCli commands", () => {
  it("returns help documentation", async () => {
    const res = await runCli(["help"]);
    expect(res.success).toBe(true);
    expect(res.output).toContain("Accord Protocol CLI");
  });

  it("handles deploy and emits JSON output", async () => {
    const res = await runCli(["deploy", "--json"]);
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output);
    expect(parsed.command).toBe("deploy");
    expect(parsed.data.action).toBe("deploy");
  });

  it("rejects propose when required parameters are missing", async () => {
    const res = await runCli(["propose", "--json"]);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Missing required option --to");
  });

  it("executes custom executor handlers", async () => {
    let executedAction = "";
    const res = await runCli(
      ["approve", "--id=42", "--json"],
      async (cmd, args) => {
        executedAction = `${cmd}:${args.proposalId}`;
        return { custom: true };
      }
    );
    expect(res.success).toBe(true);
    expect(executedAction).toBe("approve:42");
  });
});
