"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PERSONAS,
  type CurrentUser,
  type InboxItem,
  type PersonaKey,
  fetchApprovalsInbox,
  getCurrentUser,
} from "@/lib/cfcApi";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";

function InboxRow({ item, persona }: { item: InboxItem; persona: PersonaKey }) {
  const draft = item.draft;
  const session = item.session;
  const level = session.can_decide_l2 ? 2 : session.can_decide_l1 ? 1 : null;
  const version = draft.current_version;
  const reason = item.latest_review_reason;
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text">{draft.title ?? draft.id}</span>
            <StatusPill status={draft.status} />
            {level && (
              <span className="rounded border border-border-strong bg-surface-sunken px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                Action L{level}
              </span>
            )}
            {item.open_threads > 0 && (
              <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
                {item.open_threads} open thread{item.open_threads === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-text-muted">
            <span className="font-mono">{draft.id}</span>
            {" · "}v{version}
            {" · maker "}
            {item.maker_name ?? draft.maker_employee_id}
            {" · "}
            {draft.division_code}
          </div>
          {reason && (
            <div className="mt-2 rounded-lg border border-status-changes-border bg-status-changes-surface/40 p-2 text-[12px] text-text">
              <div className="mb-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-status-changes-text">
                <span>Prior review reason</span>
                <span>by {reason.author_name ?? reason.author_employee_id}</span>
              </div>
              <div className="line-clamp-3 whitespace-pre-wrap">{reason.body}</div>
            </div>
          )}
        </div>
        <Link
          href={`/studio?draft=${encodeURIComponent(draft.id)}&persona=${encodeURIComponent(persona)}`}
          className="shrink-0 self-start rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
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

  const [me, setMe] = useState<CurrentUser | null>(null);
  useEffect(() => {
    void getCurrentUser().then(setMe);
  }, []);

  const l1 = useMemo(() => items.filter((i) => i.session.can_decide_l1), [items]);
  const l2 = useMemo(() => items.filter((i) => i.session.can_decide_l2), [items]);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6 text-text">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Approvals inbox</h1>
        <p className="text-xs text-text-muted">
          Drafts awaiting your L1 or L2 decision. Silo-scoped to your division; SG / Admin see all boards.
        </p>
        <div className="ml-auto flex items-center gap-2">
          {me?.auth_mode === "personas" && (
            <label className="text-xs text-text-muted">
              Persona
              <select
                className="ml-2 rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text"
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
          )}
          <button
            type="button"
            onClick={() => void load(persona)}
            disabled={busy}
            className="rounded-lg border border-border-strong px-3 py-1 text-xs text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            {busy ? "Loading…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text">
          {error}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-text-muted">
          Awaiting L1 · {l1.length}
        </h2>
        {l1.length === 0 ? (
          <EmptyState>Nothing waiting on L1 from this persona.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {l1.map((item) => (
              <InboxRow key={item.draft.id} item={item} persona={persona} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-text-muted">
          Awaiting L2 · {l2.length}
        </h2>
        {l2.length === 0 ? (
          <EmptyState>Nothing waiting on L2 from this persona.</EmptyState>
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
