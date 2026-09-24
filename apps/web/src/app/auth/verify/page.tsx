"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { verifyMagicLink } from "@/lib/cfcApi";

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
        <p className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">
          {error}
        </p>
        <a href="/login" className="text-sm text-emerald-400 underline hover:text-emerald-300">
          Back to sign in
        </a>
      </div>
    );
  }

  return <p className="text-sm text-zinc-400">Signing you in…</p>;
}

export default function VerifyPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-6 p-8">
      <Suspense fallback={<p className="text-sm text-zinc-400">Signing you in…</p>}>
        <VerifyInner />
      </Suspense>
    </main>
  );
}
