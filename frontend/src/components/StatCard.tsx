export function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-1">{label}</p>
      <p className="text-xl font-semibold">{value}</p>
      <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">{sub}</p>
    </div>
  );
}
