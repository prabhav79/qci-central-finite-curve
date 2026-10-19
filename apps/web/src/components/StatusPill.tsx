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

export const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_L1_REVIEW: "Awaiting first review",
  APPROVED_L1_PENDING_L2: "Awaiting final approval",
  FINAL_APPROVED: "Approved",
  REJECTED: "Rejected",
  CHANGES_REQUESTED: "Changes requested",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? "Draft";
}

/** Canonical status pill, reused everywhere a document's workflow status is
 * shown so the wording and colours never drift apart. */
export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
        TONE[status] ?? "bg-status-draft-surface text-status-draft-text"
      }`}
    >
      {statusLabel(status)}
    </span>
  );
}
