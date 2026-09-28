import Image from "next/image";
import Link from "next/link";
import qciLogo from "../../public/qci-logo.webp";

export default function Home() {
  return (
    <main className="min-h-screen bg-surface text-text">
      <section className="mx-auto flex max-w-3xl flex-col gap-8 px-6 pb-16 pt-20 sm:pt-28">
        <div className="animate-rise-in">
          {/* QCI's wordmark has black text baked into the asset — a light
           * card keeps it legible on both the Paper and Night surfaces
           * rather than only working on a white background. */}
          <div className="inline-block rounded-lg bg-white px-4 py-3 shadow-sm">
            <Image src={qciLogo} alt="Quality Council of India" priority className="h-10 w-auto" />
          </div>
        </div>

        <div className="animate-rise-in [animation-delay:80ms]">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-accent">QCI · PPID</p>
          <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Central Finite Curve
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-text-muted">
            The institutional drafting platform for PPID — grounded generation over QCI&apos;s own
            work-order corpus, division-scoped review, and a versioned SuperDoc editor in place of
            the old file-shuffling workflow.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 animate-rise-in [animation-delay:140ms]">
          <Link
            href="/studio"
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Open Document Studio
          </Link>
          <Link
            href="/login"
            className="rounded-lg border border-border-strong px-5 py-2.5 text-sm font-medium text-text transition-colors hover:bg-surface-sunken"
          >
            Sign in
          </Link>
        </div>
      </section>

      <div className="animate-rise-in [animation-delay:200ms]">
        <div className="bg-gradient-to-r from-[#0a3d5c] via-accent to-[#0a3d5c] px-6 py-3 text-center text-sm font-medium text-white">
          Institutional RAG · Org RBAC · Versioned SuperDoc governance
        </div>
      </div>

      <section className="mx-auto max-w-3xl px-6 py-12">
        <div className="rounded-xl border border-border bg-surface-raised p-5 animate-rise-in [animation-delay:240ms]">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Getting started</p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-text-muted">
            <li>
              Start API: <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-text">npm run dev:api</code>
            </li>
            <li>
              Start web: <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-text">npm run dev:web</code>
            </li>
            <li>In Studio: New draft → describe what you need → review → Submit L1 → L1 Approve → L2 Final</li>
          </ol>
        </div>
      </section>
    </main>
  );
}
