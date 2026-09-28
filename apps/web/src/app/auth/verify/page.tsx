"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { verifyMagicLink } from "@/lib/cfcApi";
import { AuthShell } from "@/components/AuthShell";

function Spinner() {
  return (
    <div
      className="h-6 w-6 animate-spin rounded-full border-2 border-border-strong border-t-accent"
      aria-hidden
    />
  );
}

function SigningIn() {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <Spinner />
      <p className="text-sm text-text-muted">Signing you in…</p>
    </div>
  );
}

function VerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get("token");
    if (!token) {
      setError("Missing sign-in token.");
      return;
    }
    let cancelled = false;
    verifyMagicLink(token)
      .then(() => {
        if (!cancelled) router.replace("/studio");
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Sign-in link is invalid or expired.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  if (error) {
    return (
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text">
          {error}
        </p>
        <a href="/login" className="text-sm text-accent underline hover:text-accent-hover">
          Back to sign in
        </a>
      </div>
    );
  }

  return <SigningIn />;
}

export default function VerifyPage() {
  return (
    <AuthShell>
      <Suspense fallback={<SigningIn />}>
        <VerifyInner />
      </Suspense>
    </AuthShell>
  );
}
