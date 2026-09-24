import Link from "next/link";
import { ReactNode } from "react";

export default function StudioLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-900/80 px-4 py-2 text-sm">
        <span className="text-xs uppercase tracking-wider text-zinc-500">CFC</span>
        <Link href="/studio" className="rounded px-2 py-1 hover:bg-zinc-800">
          Studio
        </Link>
        <Link href="/studio/inbox" className="rounded px-2 py-1 hover:bg-zinc-800">
          Approvals inbox
        </Link>
        <Link href="/studio/templates" className="rounded px-2 py-1 hover:bg-zinc-800">
          Templates
        </Link>
        <span className="ml-auto text-[11px] text-zinc-600">
          feat/cfc-v4-superdoc · Sprint 5
        </span>
      </nav>
      {children}
    </div>
  );
}
