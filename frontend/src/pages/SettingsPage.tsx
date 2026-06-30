import { useEffect, useState } from "react";
import { getContractXlmBalance, getContractUsdcBalance } from "../lib/contract";
import type { DashboardStat } from "../types/accord";

type SettingsPageProps = {
  stats: DashboardStat[];
};

export function SettingsPage({ stats }: SettingsPageProps) {
  const contractId = import.meta.env.VITE_CONTRACT_ADDRESS ?? "Unknown";
  const network = import.meta.env.VITE_NETWORK_PASSPHRASE ?? "Unknown";
  const threshold = stats.find((stat) => stat.label === "Threshold")?.value ?? "Unknown";

  const [xlmBalance, setXlmBalance] = useState<string>("—");
  const [usdcBalance, setUsdcBalance] = useState<string>("—");
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setBalanceLoading(true);
      const [xlm, usdc] = await Promise.all([
        getContractXlmBalance().catch(() => "—"),
        getContractUsdcBalance().catch(() => "—"),
      ]);
      if (!cancelled) {
        setXlmBalance(xlm);
        setUsdcBalance(usdc);
        setBalanceLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(contractId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API not available
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Reference information for your deployed contract and connected network.
        </p>
      </div>

      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="text-sm text-zinc-500 mb-2">Contract ID</div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-sm text-zinc-100 break-all flex-1">{contractId}</div>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="text-sm text-zinc-500 mb-2">Network</div>
          <div className="text-sm text-zinc-100">{network}</div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
          <div className="text-sm text-zinc-500 mb-2">Threshold</div>
          <div className="text-sm text-zinc-100">{threshold}</div>
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-5">
        <h2 className="text-lg font-semibold mb-4">Fund Contract</h2>
        <p className="text-sm text-zinc-400 mb-4">
          Deposit tokens to this contract address to enable proposal payouts.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-xs text-zinc-500 mb-1">XLM Balance</div>
            <div className="text-xl font-mono font-semibold text-zinc-100">
              {balanceLoading ? (
                <span className="inline-block h-5 w-16 animate-pulse rounded bg-zinc-800" />
              ) : xlmBalance === "—" ? (
                <span className="text-zinc-500">—</span>
              ) : (
                <>{xlmBalance} XLM</>
              )}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="text-xs text-zinc-500 mb-1">USDC Balance</div>
            <div className="text-xl font-mono font-semibold text-zinc-100">
              {balanceLoading ? (
                <span className="inline-block h-5 w-16 animate-pulse rounded bg-zinc-800" />
              ) : usdcBalance === "—" || usdcBalance === "N/A" ? (
                <span className="text-zinc-500">{usdcBalance}</span>
              ) : (
                <>{usdcBalance} USDC</>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
