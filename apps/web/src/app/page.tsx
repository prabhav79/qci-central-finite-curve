import Image from "next/image";
import Link from "next/link";
import qciLogo from "../../public/qci-logo.webp";

const CAPABILITIES = [
  {
    title: "Start from a brief",
    body: "Describe what you need in a few lines. The assistant asks a few quick questions, then writes a complete first draft, section by section.",
  },
  {
    title: "Grounded in QCI's own documents",
    body: "Drafts draw on QCI's past proposals and work orders, so they reflect how QCI actually works. Statements to double-check are pointed out.",
  },
  {
    title: "Review and approve with a full audit trail",
    body: "Documents move from author to first review to final approval. Every version, comment and decision is kept on record.",
  },
];

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col bg-surface text-text">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pb-14 pt-16 sm:pt-24">
        <div className="animate-rise-in">
          {/* The wordmark has black text baked in, so it sits on a white card
           * to stay legible on both light and dark backgrounds. */}
          <div className="inline-block rounded-lg bg-white px-4 py-3 shadow-sm">
            <Image src={qciLogo} alt="Quality Council of India" priority className="h-10 w-auto" />
          </div>
        </div>

        <div className="animate-rise-in [animation-delay:80ms]">
          <p className="text-[13px] font-medium uppercase tracking-[0.2em] text-accent">
            Quality Council of India
          </p>
          <h1 className="mt-3 font-display text-4xl font-medium tracking-tight text-balance sm:text-5xl">
            Central Finite Curve
          </h1>
          <p className="mt-2 font-display text-xl text-text-muted sm:text-2xl">
            QCI&apos;s workspace for proposals, work orders and reports
          </p>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-text">
            Draft, review and approve QCI documents in one place, with AI help drawn from QCI&apos;s
            past work.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 animate-rise-in [animation-delay:140ms]">
          <Link
            href="/studio"
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Open documents
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
        <div className="bg-gradient-to-r from-accent-hover via-accent to-accent-hover px-6 py-3 text-center text-sm font-medium text-white">
          AI-assisted drafting · Two-level approval · Full version history
        </div>
      </div>

      <section className="flex-1 bg-surface-sunken">
        <div className="mx-auto grid w-full max-w-5xl gap-4 px-6 py-12 sm:grid-cols-3 animate-rise-in [animation-delay:260ms]">
          {CAPABILITIES.map((c) => (
            <div key={c.title} className="rounded-xl border border-border bg-surface-raised p-5 shadow-sm">
              <h2 className="font-display text-lg font-medium leading-snug text-text">{c.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">{c.body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
