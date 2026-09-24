"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PERSONAS,
  type InboxItem,
  type PersonaKey,
  fetchApprovalsInbox,
} from "@/lib/cfcApi";

function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    DRAFT: "bg-zinc-800 text-zinc-300",
    PENDING_L1_REVIEW: "bg-amber-950 text-amber-300 border border-amber-800",
    APPROVED_L1_PENDING_L2: "bg-violet-950 text-violet-300 border border-violet-800",
    FINAL_APPROVED: "bg-emerald-950 text-emerald-300 border border-emerald-800",
    REJECTED: "bg-red-950 text-red-300 border border-red-800",
    CHANGES_REQUESTED: "bg-orange-950 text-orange-300 border border-orange-800",
  };
  return (
    <span className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone[status] ?? "bg-zinc-800 text-zinc-300"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function InboxRow({ item, persona }: { item: InboxItem; persona: PersonaKey }) {
  const draft = item.draft;
  const session = item.session;
  const level = session.can_decide_l2 ? 2 : session.can_decide_l1 ? 1 : null;
  const version = draft.current_version;
  const reason = item.latest_review_reason;
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">{draft.title ?? draft.id}</span>
            <StatusPill status={draft.status} />
            {level && (
              <span className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
                Action L{level}
              </span>
            )}
            {item.open_threads > 0 && (
              <span className="rounded bg-cyan-950 px-2 py-0.5 text-[10px] text-cyan-300">
                {item.open_threads} open thread{item.open_threads === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            <span className="font-mono">{draft.id}</span>
            {" · "}v{version}
            {" · maker "}
            {item.maker_name ?? draft.maker_employee_id}
            {" · "}
            {draft.division_code}
          </div>
          {reason && (
            <div className="mt-2 rounded border border-orange-900 bg-orange-950/40 p-2 text-[12px] text-orange-200">
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-orange-400">
                <span>Prior review reason</span>
                <span className="text-orange-500">by {reason.author_name ?? reason.author_employee_id}</span>
              </div>
              <div className="line-clamp-3 whitespace-pre-wrap">{reason.body}</div>
            </div>
          )}
        </div>
        <Link
          href={`/studio?draft=${encodeURIComponent(draft.id)}&persona=${encodeURIComponent(persona)}`}
          className="shrink-0 self-start rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
        >
          Open in Studio
        </Link>
      </div>
    </li>
  );
}

export function ApprovalsInbox() {
  const [persona, setPersona] = useState<PersonaKey>("aashna");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: PersonaKey) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchApprovalsInbox(p);
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(persona);
  }, [persona, load]);

  const l1 = useMemo(() => items.filter((i) => i.session.can_decide_l1), [items]);
  const l2 = useMemo(() => items.filter((i) => i.session.can_decide_l2), [items]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Approvals inbox</h1>
        <p className="text-xs text-zinc-500">
          Drafts awaiting your L1 or L2 decision. Silo-scoped to your division; SG / Admin see all boards.
        </p>
        <label className="ml-auto text-xs text-zinc-400">
          Persona
          <select
            className="ml-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            value={persona}
            onChange={(e) => setPersona(e.target.value as PersonaKey)}
          >
            {Object.entries(PERSONAS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void load(persona)}
          disabled={busy}
          className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div className="rounded border border-red-900 bg-red-950/50 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Awaiting L1 · {l1.length}
        </h2>
        {l1.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-800 p-4 text-sm text-zinc-600">
            Nothing waiting on L1 from this persona.
          </p>
        ) : (
          <ul className="space-y-2">
            {l1.map((item) => (
              <InboxRow key={item.draft.id} item={item} persona={persona} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Awaiting L2 · {l2.length}
        </h2>
        {l2.length === 0 ? (
          <p className="rounded border border-dashed border-zinc-800 p-4 text-sm text-zinc-600">
            Nothing waiting on L2 from this persona.
          </p>
        ) : (
          <ul className="space-y-2">
            {l2.map((item) => (
              <InboxRow key={item.draft.id} item={item} persona={persona} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
