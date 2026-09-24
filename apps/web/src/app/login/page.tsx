"use client";

import { useState } from "react";
import { requestMagicLink } from "@/lib/cfcApi";

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
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-emerald-400">QCI · PPID</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Sign in to CFC</h1>
        <p className="mt-2 text-sm text-zinc-400">
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
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={status.kind === "sending"}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          {status.kind === "sending" ? "Sending…" : "Send sign-in link"}
        </button>
      </form>

      {status.kind === "sent-email" && (
        <p className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          Check your inbox at {email} for a sign-in link. It expires in 15 minutes.
        </p>
      )}

      {status.kind === "sent-dev-link" && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
          <p className="mb-2">
            No email delivery configured yet — use this link to sign in:
          </p>
          <a
            href={status.link}
            className="break-all text-emerald-400 underline hover:text-emerald-300"
          >
            {status.link}
          </a>
        </div>
      )}

      {status.kind === "error" && (
        <p className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">
          {status.message}
        </p>
      )}
    </main>
  );
}
