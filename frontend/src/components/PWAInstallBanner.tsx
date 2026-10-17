import { Download, X } from "lucide-react";
import { usePWAInstall } from "../lib/pwa";

export function PWAInstallBanner() {
  const { canInstall, promptInstall, dismiss } = usePWAInstall();

  if (!canInstall) return null;

  return (
    <div
      data-testid="pwa-install-banner"
      className="bg-emerald-950/70 border-b border-emerald-500/30 px-4 py-2.5 text-xs text-emerald-200"
    >
      <div className="mx-auto max-w-4xl flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Download size={14} className="text-emerald-400 shrink-0" />
          <span>
            Install Accord on your device for instant offline access and direct deep links.
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={promptInstall}
            className="rounded-md bg-emerald-500 text-black px-2.5 py-1 font-semibold hover:bg-emerald-400 transition-colors"
          >
            Install
          </button>
          <button
            type="button"
            aria-label="Dismiss install prompt"
            onClick={dismiss}
            className="p-1 text-emerald-400 hover:text-white transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
