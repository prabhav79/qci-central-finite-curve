"use client";

import { useState } from "react";
import { requestMagicLink } from "@/lib/cfcApi";
import { AuthShell } from "@/components/AuthShell";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent-email" }
  | { kind: "sent-dev-link"; link: string }
  | { kind: "error"; message: string };

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: "sending" });
    try {
      const res = await requestMagicLink(email.trim());
      if (res.delivery === "resend" || res.delivery === "email") {
        setStatus({ kind: "sent-email" });
      } else if (res.link) {
        setStatus({ kind: "sent-dev-link", link: res.link });
      } else {
        setStatus({ kind: "error", message: "Link could not be created. Try again." });
      }
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "Sign-in failed",
      });
    }
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">QCI · PPID</p>
          <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">Sign in to CFC</h1>
          <p className="mt-2 text-sm text-text-muted">
            Use your @qcin.org email. We&apos;ll send a one-click sign-in link.
          </p>
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            required
            placeholder="you@qcin.org"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-focus-ring/30"
          />
          <button
            type="submit"
            disabled={status.kind === "sending"}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {status.kind === "sending" ? "Sending…" : "Send sign-in link"}
          </button>
        </form>

        {status.kind === "sent-email" && (
          <p className="rounded-lg border border-status-approved-border bg-status-approved-surface p-3 text-sm text-status-approved-text">
            Check your inbox at {email} for a sign-in link. It expires in 15 minutes.
          </p>
        )}

        {status.kind === "sent-dev-link" && (
          <div className="rounded-lg border border-status-pending-l1-border bg-status-pending-l1-surface p-3 text-sm text-status-pending-l1-text">
            <p className="mb-2">No email delivery configured yet — use this link to sign in:</p>
            <a href={status.link} className="break-all font-medium underline">
              {status.link}
            </a>
          </div>
        )}

        {status.kind === "error" && (
          <p className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text">
            {status.message}
          </p>
        )}
      </div>
    </AuthShell>
  );
}
