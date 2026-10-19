"use client";

import { useEffect, useState } from "react";
import { type AuthConfig, errorText, getAuthConfig, requestMagicLink } from "@/lib/cfcApi";
import { AuthShell } from "@/components/AuthShell";

type Status =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent-email" }
  | { kind: "ready"; link: string }
  | { kind: "error"; message: string };

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    void getAuthConfig().then(setConfig);
  }, []);

  const needsCode = Boolean(config?.access_code_required);
  const sendsEmail = config?.email_delivery === "email";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ kind: "sending" });
    try {
      const res = await requestMagicLink(email.trim(), needsCode ? accessCode : undefined);
      if (res.link) {
        setStatus({ kind: "ready", link: res.link });
      } else if (res.ok !== false) {
        setStatus({ kind: "sent-email" });
      } else {
        setStatus({ kind: "error", message: "We couldn't sign you in. Please try again." });
      }
    } catch (err) {
      setStatus({ kind: "error", message: errorText(err) });
    }
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-6">
        <div>
          <p className="text-[13px] font-medium uppercase tracking-[0.2em] text-accent">
            Central Finite Curve
          </p>
          <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-text-muted">Use your @qcin.org email.</p>
        </div>

        {status.kind === "ready" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text">You&apos;re almost in.</p>
            <a
              href={status.link}
              className="rounded-lg bg-accent px-4 py-2 text-center text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Continue
            </a>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-[13px] text-text-muted">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="you@qcin.org"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-focus-ring/30"
              />
            </label>
            {needsCode && (
              <label className="flex flex-col gap-1 text-[13px] text-text-muted">
                Access code
                <input
                  type="password"
                  required
                  autoComplete="off"
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-focus-ring/30"
                />
              </label>
            )}
            <button
              type="submit"
              disabled={status.kind === "sending"}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {status.kind === "sending" ? "Signing in…" : sendsEmail ? "Send sign-in link" : "Sign in"}
            </button>
          </form>
        )}

        {status.kind === "sent-email" && (
          <p className="rounded-lg border border-status-approved-border bg-status-approved-surface p-3 text-sm text-status-approved-text">
            Check your inbox at {email} for a sign-in link. It expires in 15 minutes.
          </p>
        )}

        {status.kind === "error" && (
          <p
            role="alert"
            className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text"
          >
            {status.message}
          </p>
        )}
      </div>
    </AuthShell>
  );
}
