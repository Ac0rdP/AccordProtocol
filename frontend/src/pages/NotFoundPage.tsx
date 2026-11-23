import { EmptyState } from "../components/EmptyState";

interface NotFoundPageProps {
  onGoHome: () => void;
}

export function NotFoundPage({ onGoHome }: NotFoundPageProps) {
  return (
    <EmptyState
      title="404 — Page not found"
      description="That route does not exist in this Accord app."
      action={
        <button
          type="button"
          onClick={onGoHome}
          className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white"
        >
          Back to Dashboard
        </button>
      }
    />
  );
}