import { useState, type RefObject } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { AddressBookField } from "./AddressBookField";

export type TransferDraft = {
  id: string;
  recipient: string;
  amount: string;
  token: string;
};

type TransferActionBuilderProps = {
  transfers: TransferDraft[];
  onChange: (transfers: TransferDraft[]) => void;
  firstInputRef?: RefObject<HTMLInputElement | null>;
};

let nextTransferId = 1;

export function createTransferDraft(): TransferDraft {
  return {
    id: `transfer-${nextTransferId++}`,
    recipient: "",
    amount: "",
    token: "XLM",
  };
}

export function TransferActionBuilder({
  transfers,
  onChange,
  firstInputRef,
}: TransferActionBuilderProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);

  function updateTransfer(id: string, patch: Partial<TransferDraft>) {
    onChange(
      transfers.map((transfer) =>
        transfer.id === id ? { ...transfer, ...patch } : transfer,
      ),
    );
  }

  function moveTransfer(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const sourceIndex = transfers.findIndex(({ id }) => id === sourceId);
    const targetIndex = transfers.findIndex(({ id }) => id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const reordered = [...transfers];
    const [item] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, item);
    onChange(reordered);
  }

  function moveBy(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= transfers.length) return;
    moveTransfer(transfers[index].id, transfers[target].id);
  }

  return (
    <section aria-label="Proposal transfers" className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-zinc-200">Transfer actions</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Reorder transfers by dragging or with the move buttons. All transfers
          are validated before review.
        </p>
      </div>

      <ol className="space-y-3">
        {transfers.map((transfer, index) => (
          <li
            key={transfer.id}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", transfer.id);
              setDraggedId(transfer.id);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId =
                event.dataTransfer.getData("text/plain") || draggedId;
              if (sourceId) moveTransfer(sourceId, transfer.id);
              setDraggedId(null);
            }}
            onDragEnd={() => setDraggedId(null)}
            className={`rounded-xl border bg-zinc-900/80 p-3 ${
              draggedId === transfer.id
                ? "border-emerald-500/60 opacity-60"
                : "border-zinc-700"
            }`}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
                Transfer {index + 1}
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Move transfer ${index + 1} up`}
                  onClick={() => moveBy(index, -1)}
                  disabled={index === 0}
                  className="min-h-9 rounded-md px-2 text-xs text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-40"
                >
                  Move up
                </button>
                <button
                  type="button"
                  aria-label={`Move transfer ${index + 1} down`}
                  onClick={() => moveBy(index, 1)}
                  disabled={index === transfers.length - 1}
                  className="min-h-9 rounded-md px-2 text-xs text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-40"
                >
                  Move down
                </button>
                <button
                  type="button"
                  aria-label={`Remove transfer ${index + 1}`}
                  onClick={() =>
                    onChange(transfers.filter(({ id }) => id !== transfer.id))
                  }
                  disabled={transfers.length === 1}
                  className="min-h-9 rounded-md px-2 text-xs text-red-300 hover:bg-red-500/10 focus:outline-none focus:ring-2 focus:ring-red-400 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor={
                    index === 0
                      ? "proposal-recipient-input"
                      : `proposal-recipient-input-${transfer.id}`
                  }
                  className="mb-1.5 block text-xs text-zinc-400"
                >
                  Recipient Address
                </label>
                <AddressBookField
                  idPrefix={
                    index === 0
                      ? "proposal-recipient"
                      : `proposal-recipient-${transfer.id}`
                  }
                  address={transfer.recipient}
                  isValidAddress={StrKey.isValidEd25519PublicKey(
                    transfer.recipient.trim(),
                  )}
                  onSelectAddress={(recipient) =>
                    updateTransfer(transfer.id, { recipient })
                  }
                />
                <input
                  id={
                    index === 0
                      ? "proposal-recipient-input"
                      : `proposal-recipient-input-${transfer.id}`
                  }
                  ref={index === 0 ? firstInputRef : undefined}
                  value={transfer.recipient}
                  onChange={(event) =>
                    updateTransfer(transfer.id, {
                      recipient: event.target.value,
                    })
                  }
                  placeholder="G..."
                  autoComplete="off"
                  className="mt-1.5 min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 font-mono text-base text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 sm:text-sm"
                />
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex-1">
                  <label
                    htmlFor={
                      index === 0
                        ? "proposal-amount-input"
                        : `proposal-amount-input-${transfer.id}`
                    }
                    className="mb-1.5 block text-xs text-zinc-400"
                  >
                    Amount
                  </label>
                  <input
                    id={
                      index === 0
                        ? "proposal-amount-input"
                        : `proposal-amount-input-${transfer.id}`
                    }
                    value={transfer.amount}
                    onChange={(event) =>
                      updateTransfer(transfer.id, {
                        amount: event.target.value,
                      })
                    }
                    placeholder="0.00"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    className="min-h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-base text-white placeholder-zinc-600 focus:border-zinc-500 focus:outline-none focus:ring-2 focus:ring-zinc-400 sm:text-sm"
                  />
                </div>
                <fieldset className="w-full sm:w-36">
                  <legend className="mb-1.5 text-xs text-zinc-400">Token</legend>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(["XLM", "USDC", "EURC"] as const).map((symbol) => (
                      <button
                        key={symbol}
                        type="button"
                        onClick={() =>
                          updateTransfer(transfer.id, { token: symbol })
                        }
                        aria-pressed={transfer.token === symbol}
                        className={`min-h-11 rounded-lg border px-2 py-2 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-zinc-400 ${
                          transfer.token === symbol
                            ? "border-emerald-500 bg-emerald-500/20 text-emerald-300"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
                        }`}
                      >
                        {symbol}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            </div>
          </li>
        ))}
      </ol>

      <button
        type="button"
        onClick={() => onChange([...transfers, createTransferDraft()])}
        className="min-h-11 w-full rounded-lg border border-dashed border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800/60 focus:outline-none focus:ring-2 focus:ring-zinc-400"
      >
        Add transfer
      </button>
    </section>
  );
}
