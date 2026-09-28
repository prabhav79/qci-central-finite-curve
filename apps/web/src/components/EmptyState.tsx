export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-text-muted">
      {children}
    </p>
  );
}
