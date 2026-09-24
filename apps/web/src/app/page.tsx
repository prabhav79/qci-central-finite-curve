import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 p-8">
      <div>
        <p className="text-sm uppercase tracking-[0.2em] text-emerald-400">QCI · PPID</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Central Finite Curve</h1>
        <p className="mt-3 max-w-2xl text-zinc-400">
          Institutional RAG + org RBAC + SuperDoc Document OS. Streamlit prototype is frozen;
          all new work lives in this monorepo.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <Link
          href="/studio"
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
        >
          Open Document Studio
        </Link>
        <Link
          href="/dev/superdoc-spike"
          className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-900"
        >
          SuperDoc fixture spike
        </Link>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-500">
        <li>
          Start API: <code className="text-zinc-300">npm run dev:api</code>
        </li>
        <li>
          Start web: <code className="text-zinc-300">npm run dev:web</code>
        </li>
        <li>In Studio: New draft → edit → Save → switch persona to Aashna → L1 Approve</li>
      </ol>
    </main>
  );
}
