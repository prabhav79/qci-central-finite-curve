const TONE: Record<string, string> = {
  DRAFT: "bg-status-draft-surface text-status-draft-text",
  PENDING_L1_REVIEW:
    "bg-status-pending-l1-surface text-status-pending-l1-text border border-status-pending-l1-border",
  APPROVED_L1_PENDING_L2:
    "bg-status-pending-l2-surface text-status-pending-l2-text border border-status-pending-l2-border",
  FINAL_APPROVED:
    "bg-status-approved-surface text-status-approved-text border border-status-approved-border",
  REJECTED:
    "bg-status-rejected-surface text-status-rejected-text border border-status-rejected-border",
  CHANGES_REQUESTED:
    "bg-status-changes-surface text-status-changes-text border border-status-changes-border",
};

/** Canonical status-color source of truth — reused everywhere a draft's
 * workflow status is displayed, so the vocabulary never drifts out of sync. */
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        TONE[status] ?? "bg-status-draft-surface text-status-draft-text"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
