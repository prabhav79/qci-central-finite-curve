"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  PERSONAS,
  type InboxItem,
  type PersonaKey,
  errorText,
  fetchApprovalsInbox,
  isPersonasMode,
} from "@/lib/cfcApi";
import { documentTitle, personName } from "@/lib/copy";
import { formatAgeIST, formatDateTimeIST } from "@/lib/dates";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { EmptyState } from "@/components/EmptyState";
import { StatusPill } from "@/components/StatusPill";

function InboxRow({ item, persona }: { item: InboxItem; persona: PersonaKey }) {
  const draft = item.draft;
  const reason = item.latest_review_reason;
  const updated = draft.updated_at;
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text">{documentTitle(draft)}</span>
            <StatusPill status={draft.status} />
            {item.open_threads > 0 && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                {item.open_threads} open comment{item.open_threads === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="mt-1 text-[13px] text-text-muted">
            Version {draft.current_version} · by {personName(item.maker_name, draft.maker_employee_id)}
            {updated && (
              <span title={formatDateTimeIST(updated)}> · {formatAgeIST(updated)}</span>
            )}
          </div>
          {reason && (
            <div className="mt-2 rounded-lg border border-status-changes-border bg-status-changes-surface/40 p-2 text-[13px] text-text">
              <div className="mb-0.5 text-xs font-medium text-status-changes-text">
                Earlier note from {personName(reason.author_name, reason.author_employee_id)}
              </div>
              <div className="line-clamp-3 whitespace-pre-wrap">{reason.body}</div>
            </div>
          )}
        </div>
        <Link
          href={`/studio?draft=${encodeURIComponent(draft.id)}&persona=${encodeURIComponent(persona)}`}
          className="shrink-0 self-start rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
        >
          Open
        </Link>
      </div>
    </li>
  );
}

export function ApprovalsInbox() {
  const { me, error: meError } = useCurrentUser();
  const [persona, setPersona] = useState<PersonaKey>("aashna");
  const [items, setItems] = useState<InboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: PersonaKey) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchApprovalsInbox(p);
      setItems(res.items);
    } catch (e) {
      setError(errorText(e));
      setItems([]);
    } finally {
      setBusy(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (me) void load(persona);
  }, [me, persona, load]);

  const l1 = useMemo(() => items.filter((i) => i.session.can_decide_l1), [items]);
  const l2 = useMemo(() => items.filter((i) => i.session.can_decide_l2), [items]);
  const apex = Boolean(me?.cross_division_read);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 p-6 text-text">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight">Approvals</h1>
          <p className="mt-1 text-sm text-text-muted">Documents waiting for your approval.</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isPersonasMode(me) && (
            <label className="text-[13px] text-text-muted">
              Viewing as
              <select
                className="ml-2 rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-[13px] text-text"
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
            disabled={busy || !me}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {(error || meError) && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text">
          {error ?? meError}
        </div>
      )}

      {meError ? null : !loaded ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : l1.length === 0 && l2.length === 0 && !error ? (
        apex ? (
          <Link href="/studio" className="text-sm font-medium text-accent hover:underline">
            Browse all documents
          </Link>
        ) : (
          <EmptyState>Nothing waiting for you.</EmptyState>
        )
      ) : (
        <>
          {l1.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-text">
                Waiting for first review · {l1.length}
              </h2>
              <ul className="space-y-2">
                {l1.map((item) => (
                  <InboxRow key={item.draft.id} item={item} persona={persona} />
                ))}
              </ul>
            </section>
          )}
          {l2.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-semibold text-text">
                Waiting for final approval · {l2.length}
              </h2>
              <ul className="space-y-2">
                {l2.map((item) => (
                  <InboxRow key={item.draft.id} item={item} persona={persona} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
