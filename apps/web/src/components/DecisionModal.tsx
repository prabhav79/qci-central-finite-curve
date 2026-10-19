"use client";

import { useEffect, useRef, useState } from "react";
import { errorText } from "@/lib/cfcApi";
import { Modal } from "@/components/Modal";

export type DecisionKind = "reject" | "changes_requested";

export function DecisionModal({
  open,
  kind,
  defaultAnchorText,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
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

  const title = kind === "reject" ? "Reject this document" : "Send back for changes";
  const verb = kind === "reject" ? "Reject" : "Send back";
  const tone =
    kind === "reject"
      ? "bg-action-reject hover:bg-action-reject-hover"
      : "bg-action-changes hover:bg-action-changes-hover";

  async function submit() {
    const trimmed = comment.trim();
    if (!trimmed) {
      setError("Please write a short note explaining why.");
      return;
    }
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <Modal open={open} onClose={onCancel}>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">{title}</h2>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="rounded-md px-1.5 py-0.5 text-lg leading-none text-text-muted transition-colors hover:bg-surface-sunken hover:text-text"
        >
          ×
        </button>
      </div>
      <p className="mb-3 text-[13px] text-text-muted">
        Your note will be shared with the author and kept on record.
      </p>
      {defaultAnchorText && (
        <p className="mb-2 truncate rounded-lg border border-border bg-surface-sunken px-2 py-1 text-xs text-text-muted">
          About this text: {defaultAnchorText}
        </p>
      )}
      <textarea
        ref={ref}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={6}
        aria-label="Your note"
        placeholder={
          kind === "reject"
            ? "Why is this document being rejected? What would need to change?"
            : "What should the author change before sending it back?"
        }
        className="w-full rounded-lg border border-border-strong bg-surface-sunken p-2 text-sm text-text outline-none focus:border-accent"
      />
      {error && <p className="mt-2 text-[13px] text-status-rejected-text">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className={`rounded-lg px-3 py-1.5 text-[13px] font-medium text-white transition-colors ${tone} disabled:opacity-50`}
        >
          {busy ? "Sending…" : verb}
        </button>
      </div>
    </Modal>
  );
}
