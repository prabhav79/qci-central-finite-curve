"use client";

import { useEffect } from "react";

/** Shared centered-overlay shell for every modal in the app (New draft,
 * decision/reject, draft-intake Q&A) — one place for the backdrop, card
 * styling, entrance animation, and Escape-to-close instead of three copies
 * drifting apart. */
export function Modal({
  open,
  onClose,
  maxWidth = "max-w-lg",
  children,
}: {
  open: boolean;
  /** Escape key triggers this, same as a Cancel/close button — omit if the
   * modal has no safe "just back out" action. */
  onClose?: () => void;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open || !onClose) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose?.();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className={`animate-rise-in w-full ${maxWidth} rounded-xl border border-border bg-surface-raised p-4 shadow-xl`}
      >
        {children}
      </div>
    </div>
  );
}
