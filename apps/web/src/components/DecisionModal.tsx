"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";

export type DecisionKind = "reject" | "changes_requested";

export function DecisionModal({
  open,
  level,
  kind,
  defaultAnchorText,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  level: 1 | 2;
  kind: DecisionKind;
  defaultAnchorText?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (comment: string) => Promise<void> | void;
}) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (open) {
      setComment("");
      setError(null);
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [open]);

  if (!open) return null;

  const title = kind === "reject" ? `Reject at L${level}` : `Request changes at L${level}`;
  const verb = kind === "reject" ? "Reject" : "Send back";
  const tone =
    kind === "reject"
      ? "bg-action-reject hover:bg-action-reject-hover"
      : "bg-action-changes hover:bg-action-changes-hover";

  async function submit() {
    const trimmed = comment.trim();
    if (!trimmed) {
      setError("A written reason is required.");
      return;
    }
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal open={open} onClose={onCancel}>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        <button type="button" onClick={onCancel} className="text-xs text-text-muted hover:text-text">
          Esc
        </button>
      </div>
      <p className="mb-3 text-xs text-text-muted">
        This reason is stored as a review thread on the draft. The maker will see it in Threads and
        the audit log. Approvals cannot be undone; be specific.
      </p>
      {defaultAnchorText && (
        <p className="mb-2 truncate rounded-lg border border-border bg-surface-sunken px-2 py-1 text-[11px] text-text-muted">
          Anchor context: {defaultAnchorText}
        </p>
      )}
      <textarea
        ref={ref}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={6}
        placeholder={
          kind === "reject"
            ? "Why is this draft being rejected? What must change before another submission?"
            : "What changes do you want the maker to make before resubmitting?"
        }
        className="w-full rounded-lg border border-border-strong bg-surface-sunken p-2 text-sm text-text outline-none focus:border-accent"
      />
      {error && <p className="mt-2 text-xs text-status-rejected-text">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className={`rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors ${tone} disabled:opacity-50`}
        >
          {busy ? "Sending…" : verb}
        </button>
      </div>
    </Modal>
  );
}
