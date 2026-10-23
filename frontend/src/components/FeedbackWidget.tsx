import { useEffect, useState } from "react";
import { MessageSquare, X, Send, ExternalLink } from "lucide-react";

interface FeedbackContext {
  route: string;
  url: string;
  network?: string;
  contractId?: string;
  walletAddress?: string;
  userAgent: string;
  timestamp: string;
  appVersion?: string;
}

interface FeedbackWidgetProps {
  walletAddress?: string | null;
}

const RATE_LIMIT_KEY = "accord_feedback_submissions";
const MAX_SUBMISSIONS = 5;
const COOLDOWN_MS = 60000; // 1 minute

function getFeedbackContext(walletAddress?: string | null): FeedbackContext {
  const network = import.meta.env.VITE_NETWORK_PASSPHRASE || 
                  import.meta.env.VITE_NETWORK || 
                  "Unknown";
  
  const contractId = import.meta.env.VITE_CONTRACT_ADDRESS || 
                     import.meta.env.VITE_CONTRACT_ID;
  
  const appVersion = import.meta.env.VITE_APP_VERSION || 
                     import.meta.env.VITE_BUILD_VERSION ||
                     "dev";
  
  return {
    route: window.location.pathname,
    url: window.location.href,
    network: network.includes("Test") ? "Testnet" : network.includes("Public") ? "Mainnet" : network,
    contractId,
    walletAddress: walletAddress || undefined,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    appVersion,
  };
}

function checkRateLimit(): { allowed: boolean; message?: string } {
  try {
    const data = localStorage.getItem(RATE_LIMIT_KEY);
    const submissions = data ? JSON.parse(data) : [];
    
    // Remove old submissions older than cooldown period
    const now = Date.now();
    const recent = submissions.filter((s: number) => now - s < COOLDOWN_MS);
    
    if (recent.length >= MAX_SUBMISSIONS) {
      return {
        allowed: false,
        message: "Too many feedback submissions. Please wait a moment before trying again.",
      };
    }
    
    recent.push(now);
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(recent));
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

function buildIssueBody(feedbackType: string, title: string, description: string, context: FeedbackContext): string {
  let body = `## Feedback Type\n${feedbackType}\n\n`;
  body += `## Summary\n${title}\n\n`;
  body += `## Description\n${description}\n\n`;
  body += `## Context\n`;
  body += `- **Page/Route:** ${context.route}\n`;
  body += `- **Full URL:** ${context.url}\n`;
  body += `- **Network:** ${context.network}\n`;
  if (context.contractId) body += `- **Contract ID:** ${context.contractId}\n`;
  if (context.walletAddress) body += `- **Wallet:** ${context.walletAddress}\n`;
  body += `- **App Version:** ${context.appVersion}\n`;
  body += `- **Browser:** ${context.userAgent}\n`;
  body += `- **Submitted:** ${context.timestamp}\n\n`;
  body += `---\n*Submitted via in-app feedback widget*`;
  return body;
}

export function FeedbackWidget({ walletAddress }: FeedbackWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [feedbackType, setFeedbackType] = useState("Bug Report");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setError(null);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Please provide a title");
      return;
    }
    if (!description.trim()) {
      setError("Please provide a description");
      return;
    }
    if (title.length > 256) {
      setError("Title is too long (max 256 characters)");
      return;
    }

    const rateCheck = checkRateLimit();
    if (!rateCheck.allowed) {
      setError(rateCheck.message || "Rate limit exceeded");
      return;
    }

    setSubmitting(true);

    try {
      const context = getFeedbackContext(walletAddress);
      const issueTitle = `[Feedback]: ${title}`;
      const issueBody = buildIssueBody(feedbackType, title, description, context);
      
      const repo = import.meta.env.VITE_GITHUB_REPO || "connelevalsam/AccordProtocol";
      const issueUrl = `https://github.com/${repo}/issues/new?` + 
        new URLSearchParams({
          title: issueTitle,
          body: issueBody,
          labels: feedbackType === "Bug Report" ? "bug,feedback" : feedbackType === "Feature Request" ? "enhancement,feedback" : "feedback"
        }).toString();
      
      window.open(issueUrl, "_blank", "noopener,noreferrer");
      
      // Reset form
      setTitle("");
      setDescription("");
      setFeedbackType("Bug Report");
      setIsOpen(false);
    } catch (err) {
      setError("Failed to submit feedback. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-zinc-800 dark:text-white transition-colors hover:text-black dark:hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
        aria-label="Send feedback"
        title="Send feedback"
      >
        <MessageSquare size={16} />
        <span className="hidden md:inline">Feedback</span>
      </button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setIsOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-title"
        >
          <div
            className="relative w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
              <h2 id="feedback-title" className="text-lg font-semibold text-white">
                Send Feedback
              </h2>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-lg p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-zinc-400"
                aria-label="Close feedback"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-6">
              <div className="mb-4">
                <label htmlFor="feedback-type" className="mb-2 block text-sm font-medium text-zinc-300">
                  Type
                </label>
                <select
                  id="feedback-type"
                  value={feedbackType}
                  onChange={(e) => setFeedbackType(e.target.value)}
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                >
                  <option value="Bug Report">Bug Report</option>
                  <option value="Feature Request">Feature Request</option>
                  <option value="General Feedback">General Feedback</option>
                </select>
              </div>

              <div className="mb-4">
                <label htmlFor="feedback-title-input" className="mb-2 block text-sm font-medium text-zinc-300">
                  Title
                </label>
                <input
                  id="feedback-title-input"
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={256}
                  placeholder="Brief summary of your feedback"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  required
                />
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{title.length}/256</p>
              </div>

              <div className="mb-4">
                <label htmlFor="feedback-description" className="mb-2 block text-sm font-medium text-zinc-300">
                  Description
                </label>
                <textarea
                  id="feedback-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  placeholder="Provide details about your feedback, steps to reproduce if it's a bug, etc."
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-white placeholder-zinc-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  required
                />
              </div>

              <div className="mb-4 rounded-lg bg-zinc-800/50 p-3 text-xs text-zinc-400">
                <p className="mb-1 font-medium text-zinc-300">Context that will be included:</p>
                <ul className="space-y-0.5">
                  <li>• Page: {window.location.pathname}</li>
                  <li>• Network: {getFeedbackContext(walletAddress).network}</li>
                  {walletAddress && <li>• Wallet: {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</li>}
                </ul>
              </div>

              {error && (
                <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2 text-sm text-red-400">
                  {error}
                </div>
              )}

              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  <ExternalLink size={12} className="inline mr-1" />
                  Opens GitHub issue
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="rounded-lg px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800 focus:outline-none focus:ring-2 focus:ring-zinc-400"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-600 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50"
                  >
                    <Send size={16} />
                    {submitting ? "Submitting..." : "Submit"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
