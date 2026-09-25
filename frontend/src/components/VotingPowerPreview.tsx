import React from "react";
import { formatWeightPercent } from "../lib/soroban";

export interface VotingPowerPreviewProps {
  beforeWeight: number;
  afterWeight: number;
  totalWeight: number; // Resulting total weight after the action
  type: "add_owner" | "remove_owner" | "change_owner_weight";
  threshold?: number;   // Relevant for remove_owner (quorumWeight)
  weightCapPct?: number; // Relevant for change_owner_weight (weightCapPct)
  note?: string;
  warning?: {
    show: boolean;
    message: React.ReactNode;
  };
}

export function VotingPowerPreview({
  beforeWeight,
  afterWeight,
  totalWeight,
  type,
  threshold,
  weightCapPct,
  note,
  warning,
}: VotingPowerPreviewProps) {
  return (
    <div className="mt-3 text-xs space-y-1">
      <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg p-3">
        <p className="text-zinc-300 font-medium font-sans mb-1">Live Impact Preview</p>
        
        {type === "add_owner" && (
          <>
            <p>
              Total voting weight will increase from{" "}
              <span className="font-mono text-zinc-200">{beforeWeight}</span> to{" "}
              <span className="font-mono text-zinc-200">{afterWeight}</span>.
            </p>
            <p>
              New owner percentage share:{" "}
              <span className="font-mono text-zinc-300">
                {formatWeightPercent(1, totalWeight)}
              </span>
              .
            </p>
          </>
        )}

        {type === "remove_owner" && (
          <>
            <p>
              Owner's current weight:{" "}
              <span className="font-mono text-zinc-200">{beforeWeight}</span>.
            </p>
            <p>
              Resulting total voting weight:{" "}
              <span className="font-mono text-zinc-200">{totalWeight}</span>
              {threshold !== undefined && (
                <>
                  {" "}(threshold:{" "}
                  <span className="font-mono text-zinc-200">{threshold}</span>)
                </>
              )}
              .
            </p>
          </>
        )}

        {type === "change_owner_weight" && (
          <>
            <p>
              Resulting total voting weight:{" "}
              <span className="font-mono text-zinc-200">{totalWeight}</span>.
            </p>
            <p>
              Owner's new share:{" "}
              <span className="font-mono text-zinc-200">
                {formatWeightPercent(afterWeight, totalWeight)}
              </span>
              {weightCapPct !== undefined && (
                <>
                  {" "}(cap:{" "}
                  <span className="font-mono text-zinc-200">{weightCapPct}%</span>)
                </>
              )}
              .
            </p>
          </>
        )}

        {note && (
          <p className="text-zinc-500 italic mt-1 font-sans">
            {note}
          </p>
        )}
      </div>

      {warning && warning.show && (
        <div className="mt-2 flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-lg p-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4 shrink-0 mt-0.5"
          >
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0v-4.5A.75.75 0 0110 5zm0 10a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          <div className="leading-normal font-sans">
            {warning.message}
          </div>
        </div>
      )}
    </div>
  );
}
