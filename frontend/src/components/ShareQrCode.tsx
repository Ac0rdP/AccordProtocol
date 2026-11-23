import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { ErrorState } from "./ErrorState";
import { LoadingState } from "./LoadingState";

type ShareQrCodeProps = {
  /** Link encoded in the QR code (proposal or payment-request URL). */
  url: string;
  /** Used for the heading and the downloaded file name, e.g. "proposal-12". */
  name: string;
  label?: string;
};

/** Renders a downloadable QR code for a share link so mobile signers can open it quickly. */
export function ShareQrCode({ url, name, label = "Scan to open on mobile" }: ShareQrCodeProps) {
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const requestKey = `${url}#${attempt}`;
  const [result, setResult] = useState<{ key: string; dataUrl?: string; error?: string } | null>(null);

  useEffect(() => {
    if (!url) return;
    let active = true;
    QRCode.toDataURL(url, { width: 240, margin: 1 })
      .then((dataUrl) => {
        if (active) setResult({ key: requestKey, dataUrl });
      })
      .catch(() => {
        if (active) setResult({ key: requestKey, error: "Could not generate QR code." });
      });
    return () => {
      active = false;
    };
  }, [url, requestKey]);

  const current = result?.key === requestKey ? result : null;
  const dataUrl = current?.dataUrl ?? null;
  const error = url ? (current?.error ?? null) : "No link to share.";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const button =
    "rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400";

  return (
    <section
      aria-labelledby={`${name}-qr-heading`}
      className="rounded-xl border border-zinc-800 bg-zinc-900 p-5"
    >
      <h2
        id={`${name}-qr-heading`}
        className="text-xs uppercase tracking-[0.2em] text-zinc-600 dark:text-zinc-400"
      >
        Share link
      </h2>

      {error ? (
        <ErrorState
          message={error}
          onRetry={url ? () => setAttempt((n) => n + 1) : undefined}
          variant="section"
        />
      ) : !dataUrl ? (
        <LoadingState message="Generating QR code…" variant="section" />
      ) : (
        <div className="mt-3 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <img
            src={dataUrl}
            alt={`QR code for ${url}`}
            width={160}
            height={160}
            className="h-40 w-40 rounded-lg bg-white p-1"
          />
          <div className="flex w-full min-w-0 flex-col gap-2">
            <p className="text-sm text-zinc-400">{label}</p>
            <p className="break-all font-mono text-xs text-zinc-500">{url}</p>
            <div className="flex flex-wrap gap-2">
              <a href={dataUrl} download={`${name}-qr.png`} className={button}>
                Download QR
              </a>
              <button type="button" onClick={copy} className={button}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
