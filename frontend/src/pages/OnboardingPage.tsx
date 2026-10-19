import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
  FileText,
} from "lucide-react";
import type { WalletState } from "../hooks/useWallet";

export interface OnboardingOwnerEntry {
  address: string;
  weight: number;
}

export interface OnboardingWizardState {
  currentStep: number;
  owners: OnboardingOwnerEntry[];
  threshold: number;
  timeLockDelay: number;
  firstProposal: {
    recipient: string;
    amount: string;
    token: string;
    description: string;
  };
  completed: boolean;
}

export const ONBOARDING_STORAGE_KEY = "accord_onboarding_wizard_progress";

const DEFAULT_INITIAL_STATE: OnboardingWizardState = {
  currentStep: 1,
  owners: [{ address: "", weight: 1 }],
  threshold: 1,
  timeLockDelay: 0,
  firstProposal: {
    recipient: "",
    amount: "",
    token: "Native (XLM)",
    description: "Initial treasury setup proposal",
  },
  completed: false,
};

export function loadOnboardingProgress(): OnboardingWizardState {
  try {
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.currentStep === "number") {
        return parsed;
      }
    }
  } catch {
    // fallback
  }
  return DEFAULT_INITIAL_STATE;
}

export function saveOnboardingProgress(state: OnboardingWizardState) {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function clearOnboardingProgress() {
  try {
    localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {}
}

interface OnboardingPageProps {
  wallet: WalletState;
  onComplete?: () => void;
}

export function OnboardingPage({ wallet, onComplete }: OnboardingPageProps) {
  const navigate = useNavigate();
  const [state, setState] = useState<OnboardingWizardState>(loadOnboardingProgress);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sync state to localStorage on every update
  useEffect(() => {
    saveOnboardingProgress(state);
  }, [state]);

  // Autofill wallet address into first owner slot if empty
  useEffect(() => {
    if (wallet.address && state.owners.length === 1 && state.owners[0].address === "") {
      setState((prev) => ({
        ...prev,
        owners: [{ address: wallet.address!, weight: 1 }],
      }));
    }
  }, [wallet.address, state.owners]);

  const updateState = (patch: Partial<OnboardingWizardState>) => {
    setState((prev) => ({ ...prev, ...patch }));
    setErrorMsg(null);
  };

  const totalWeight = state.owners.reduce((sum, o) => sum + (Number(o.weight) || 0), 0);

  // Step navigation validations
  const validateStep = (step: number): boolean => {
    if (step === 1) {
      if (!wallet.address) {
        setErrorMsg("Please connect your wallet before proceeding.");
        return false;
      }
      return true;
    }

    if (step === 2) {
      if (state.owners.length === 0) {
        setErrorMsg("Please add at least one owner.");
        return false;
      }
      for (let i = 0; i < state.owners.length; i++) {
        const o = state.owners[i];
        if (!o.address.trim()) {
          setErrorMsg(`Owner #${i + 1} address cannot be empty.`);
          return false;
        }
        if (o.weight <= 0) {
          setErrorMsg(`Owner #${i + 1} weight must be at least 1.`);
          return false;
        }
      }
      // Check duplicate addresses
      const addrs = state.owners.map((o) => o.address.trim());
      const unique = new Set(addrs);
      if (unique.size !== addrs.length) {
        setErrorMsg("Each owner address must be unique.");
        return false;
      }
      return true;
    }

    if (step === 3) {
      if (state.threshold <= 0) {
        setErrorMsg("Quorum threshold must be greater than 0.");
        return false;
      }
      if (state.threshold > totalWeight) {
        setErrorMsg(`Quorum threshold (${state.threshold}) cannot exceed total voting weight (${totalWeight}).`);
        return false;
      }
      return true;
    }

    return true;
  };

  const handleNext = () => {
    if (!validateStep(state.currentStep)) return;
    updateState({ currentStep: state.currentStep + 1 });
  };

  const handlePrev = () => {
    setErrorMsg(null);
    updateState({ currentStep: Math.max(1, state.currentStep - 1) });
  };

  const handleComplete = () => {
    if (!validateStep(state.currentStep)) return;
    updateState({ completed: true });
    try {
      localStorage.setItem("accord_onboarding_completed", "true");
    } catch {}
    if (onComplete) {
      onComplete();
    }
  };

  const addOwnerRow = () => {
    updateState({
      owners: [...state.owners, { address: "", weight: 1 }],
    });
  };

  const removeOwnerRow = (index: number) => {
    if (state.owners.length <= 1) return;
    const updated = state.owners.filter((_, i) => i !== index);
    updateState({ owners: updated });
  };

  const updateOwner = (index: number, patch: Partial<OnboardingOwnerEntry>) => {
    const updated = state.owners.map((o, i) => (i === index ? { ...o, ...patch } : o));
    updateState({ owners: updated });
  };

  const stepsList = [
    { number: 1, title: "Connect Wallet", icon: Wallet },
    { number: 2, title: "Configure Owners", icon: Users },
    { number: 3, title: "Quorum Threshold", icon: ShieldCheck },
    { number: 4, title: "First Proposal", icon: FileText },
  ];

  if (state.completed) {
    return (
      <div data-testid="onboarding-completed" className="mx-auto max-w-2xl py-12 px-4 text-center">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          <CheckCircle2 size={32} />
        </div>
        <h2 className="text-2xl font-bold tracking-tight">Multisig Setup Complete!</h2>
        <p className="mt-2 text-sm text-zinc-400">
          Your initial configuration with {state.owners.length} owners and a {state.threshold} of {totalWeight} quorum threshold is ready.
        </p>

        <div className="mt-8 flex justify-center gap-4">
          <button
            type="button"
            onClick={() => {
              clearOnboardingProgress();
              navigate("/app");
            }}
            className="rounded-lg bg-emerald-500 px-6 py-2.5 text-sm font-semibold text-black hover:bg-emerald-400 transition-colors"
          >
            Go to Dashboard
          </button>
          <button
            type="button"
            onClick={() => {
              updateState({ completed: false, currentStep: 1 });
            }}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Review Setup
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl py-8 px-4" data-testid="onboarding-wizard">
      {/* Step Indicator Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Multisig Setup Wizard</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Step-by-step onboarding for teams deploying their first Accord multisig.
        </p>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {stepsList.map(({ number, title, icon: Icon }) => {
            const isActive = state.currentStep === number;
            const isDone = state.currentStep > number;
            return (
              <div
                key={number}
                data-testid={`wizard-step-indicator-${number}`}
                className={`flex items-center gap-2.5 p-3 rounded-lg border text-xs transition-colors ${
                  isActive
                    ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300 font-semibold"
                    : isDone
                    ? "border-zinc-700 bg-zinc-800/50 text-zinc-300"
                    : "border-zinc-800 bg-zinc-900/40 text-zinc-500"
                }`}
              >
                <div
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${
                    isDone
                      ? "bg-emerald-500 text-black font-bold"
                      : isActive
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 font-bold"
                      : "bg-zinc-800 text-zinc-500"
                  }`}
                >
                  {isDone ? "✓" : number}
                </div>
                <div className="truncate flex items-center gap-1.5">
                  <Icon size={12} className="shrink-0 opacity-70" aria-hidden="true" />
                  <span className="truncate">{title}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {errorMsg && (
        <div
          role="alert"
          data-testid="wizard-error"
          className="mb-6 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300"
        >
          {errorMsg}
        </div>
      )}

      {/* STEP 1: Connect Wallet */}
      {state.currentStep === 1 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-6" data-testid="step-wallet">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-zinc-800 p-2 text-emerald-400">
              <Wallet size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold">Connect Deployer Wallet</h2>
              <p className="text-xs text-zinc-400">
                Connect your Stellar Freighter wallet to initiate the multisig.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
            {wallet.address ? (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-zinc-400">Connected Wallet</p>
                  <p className="font-mono text-sm text-emerald-400 mt-0.5">{wallet.address}</p>
                </div>
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 text-xs text-emerald-400 font-medium">
                  <CheckCircle2 size={13} /> Connected
                </span>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                <p className="text-xs text-zinc-400">No wallet currently connected.</p>
                <button
                  type="button"
                  onClick={wallet.connect}
                  disabled={wallet.connecting}
                  className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-black hover:bg-emerald-400 transition-colors disabled:opacity-50"
                >
                  {wallet.connecting ? "Connecting…" : "Connect Freighter"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* STEP 2: Configure Owners */}
      {state.currentStep === 2 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-6" data-testid="step-owners">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-zinc-800 p-2 text-emerald-400">
                <Users size={20} />
              </div>
              <div>
                <h2 className="text-base font-semibold">Multisig Owners & Voting Weights</h2>
                <p className="text-xs text-zinc-400">
                  Add the Stellar addresses that will hold signing keys and define their voting weight.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={addOwnerRow}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              <Plus size={14} /> Add Owner
            </button>
          </div>

          <div className="space-y-3">
            {state.owners.map((owner, idx) => (
              <div
                key={idx}
                className="flex items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
              >
                <div className="w-6 text-center text-xs font-mono text-zinc-500">#{idx + 1}</div>
                <div className="flex-1">
                  <input
                    type="text"
                    aria-label={`Owner ${idx + 1} address`}
                    placeholder="Stellar Public Key (e.g. G...)"
                    value={owner.address}
                    onChange={(e) => updateOwner(idx, { address: e.target.value })}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-white placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <div className="w-24">
                  <input
                    type="number"
                    min="1"
                    aria-label={`Owner ${idx + 1} weight`}
                    value={owner.weight}
                    onChange={(e) => updateOwner(idx, { weight: Math.max(1, parseInt(e.target.value) || 1) })}
                    className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-center text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                {state.owners.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove owner ${idx + 1}`}
                    onClick={() => removeOwnerRow(idx)}
                    className="p-1.5 text-zinc-500 hover:text-red-400 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-between text-xs text-zinc-400 pt-2 border-t border-zinc-800">
            <span>Total Signers: {state.owners.length}</span>
            <span>Total Voting Weight: {totalWeight}</span>
          </div>
        </div>
      )}

      {/* STEP 3: Quorum Threshold */}
      {state.currentStep === 3 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-6" data-testid="step-threshold">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-zinc-800 p-2 text-emerald-400">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold">Quorum Threshold & Execution Delay</h2>
              <p className="text-xs text-zinc-400">
                Specify how many approvals or voting weight are required to execute a proposal.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label htmlFor="quorum-threshold" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Required Quorum Weight
              </label>
              <div className="flex items-center gap-3">
                <input
                  id="quorum-threshold"
                  type="number"
                  min="1"
                  max={totalWeight}
                  aria-label="Required Quorum Weight"
                  value={state.threshold}
                  onChange={(e) => updateState({ threshold: parseInt(e.target.value) || 1 })}
                  className="w-32 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
                <span className="text-xs text-zinc-400">
                  of {totalWeight} total weight ({totalWeight > 0 ? ((state.threshold / totalWeight) * 100).toFixed(0) : 0}%)
                </span>
              </div>
            </div>

            <div>
              <label htmlFor="timelock-delay" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Time-Lock Delay (seconds)
              </label>
              <input
                id="timelock-delay"
                type="number"
                min="0"
                aria-label="Time-lock delay"
                value={state.timeLockDelay}
                onChange={(e) => updateState({ timeLockDelay: Math.max(0, parseInt(e.target.value) || 0) })}
                className="w-48 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <p className="mt-1 text-xs text-zinc-500">
                Optional grace period between proposal approval and execution (0 for instant execution).
              </p>
            </div>
          </div>
        </div>
      )}

      {/* STEP 4: First Proposal & Review */}
      {state.currentStep === 4 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 space-y-6" data-testid="step-proposal">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-zinc-800 p-2 text-emerald-400">
              <FileText size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold">First Proposal & Configuration Review</h2>
              <p className="text-xs text-zinc-400">
                Draft a first proposal and review your multisig parameters before finalization.
              </p>
            </div>
          </div>

          <div className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
            <h3 className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">
              Initial Proposal (Optional)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Recipient Address</label>
                <input
                  type="text"
                  placeholder="G... or leave blank"
                  value={state.firstProposal.recipient}
                  onChange={(e) =>
                    updateState({
                      firstProposal: { ...state.firstProposal, recipient: e.target.value },
                    })
                  }
                  className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 font-mono text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Amount</label>
                <input
                  type="text"
                  placeholder="e.g. 100"
                  value={state.firstProposal.amount}
                  onChange={(e) =>
                    updateState({
                      firstProposal: { ...state.firstProposal, amount: e.target.value },
                    })
                  }
                  className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Description / Memo</label>
              <input
                type="text"
                value={state.firstProposal.description}
                onChange={(e) =>
                  updateState({
                    firstProposal: { ...state.firstProposal, description: e.target.value },
                  })
                }
                className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2 text-xs">
            <div className="font-semibold text-emerald-400 mb-2">Multisig Configuration Summary</div>
            <div className="flex justify-between text-zinc-300">
              <span>Signers:</span>
              <span className="font-medium">{state.owners.length} owners</span>
            </div>
            <div className="flex justify-between text-zinc-300">
              <span>Quorum Requirement:</span>
              <span className="font-medium">
                {state.threshold} of {totalWeight} weight ({((state.threshold / totalWeight) * 100).toFixed(0)}%)
              </span>
            </div>
            <div className="flex justify-between text-zinc-300">
              <span>Time-Lock Delay:</span>
              <span className="font-medium">{state.timeLockDelay} seconds</span>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Buttons */}
      <div className="mt-6 flex items-center justify-between">
        {state.currentStep > 1 ? (
          <button
            type="button"
            onClick={handlePrev}
            className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <ChevronLeft size={14} /> Back
          </button>
        ) : (
          <div />
        )}

        {state.currentStep < 4 ? (
          <button
            type="button"
            onClick={handleNext}
            className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-5 py-2 text-xs font-semibold text-black hover:bg-emerald-400 transition-colors"
          >
            Next <ChevronRight size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleComplete}
            data-testid="complete-onboarding-btn"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-6 py-2 text-xs font-semibold text-black hover:bg-emerald-400 transition-colors"
          >
            <KeyRound size={14} /> Complete Setup
          </button>
        )}
      </div>
    </div>
  );
}
