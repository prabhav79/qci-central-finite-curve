"use client";

import { useEffect, useRef, useState } from "react";

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
  const tone = kind === "reject" ? "bg-red-600 hover:bg-red-500" : "bg-orange-600 hover:bg-orange-500";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-xl">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-xs text-zinc-500 hover:text-zinc-200"
          >
            Esc
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          This reason is stored as a review thread on the draft. The maker will see it in Threads and
          the audit log. Approvals cannot be undone; be specific.
        </p>
        {defaultAnchorText && (
          <p className="mb-2 truncate rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">
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
          className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
        />
        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className={`rounded px-3 py-1.5 text-xs font-medium text-white ${tone} disabled:opacity-50`}
          >
            {busy ? "Sending…" : verb}
          </button>
        </div>
      </div>
    </div>
  );
}
