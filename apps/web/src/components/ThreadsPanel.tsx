"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type PersonaKey,
  type ThreadRecord,
  createThread,
  fetchThreads,
  patchThread,
} from "@/lib/cfcApi";

type Filter = "open" | "resolved" | "all";

function KindTag({ kind }: { kind: ThreadRecord["kind"] }) {
  const tone: Record<ThreadRecord["kind"], string> = {
    review_reason:
      "bg-status-changes-surface text-status-changes-text border border-status-changes-border",
    comment: "bg-accent/10 text-accent border border-accent/30",
    tracked_change:
      "bg-status-pending-l2-surface text-status-pending-l2-text border border-status-pending-l2-border",
  };
  const label: Record<ThreadRecord["kind"], string> = {
    review_reason: "Review",
    comment: "Comment",
    tracked_change: "Change",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${tone[kind]}`}>
      {label[kind]}
    </span>
  );
}

export function ThreadsPanel({
  draftId,
  persona,
  canComment,
  refreshKey,
}: {
  draftId: string | undefined;
  persona: PersonaKey;
  canComment: boolean;
  refreshKey: number;
}) {
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [newComment, setNewComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!draftId) {
      setThreads([]);
      return;
    }
    setError(null);
    try {
      const res = await fetchThreads(draftId, persona);
      setThreads(res.threads);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draftId, persona]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const filtered = useMemo(() => {
    if (filter === "all") return threads;
    if (filter === "open") return threads.filter((t) => !t.resolved);
    return threads.filter((t) => t.resolved);
  }, [threads, filter]);

  const openCount = useMemo(() => threads.filter((t) => !t.resolved).length, [threads]);

  async function toggleResolved(t: ThreadRecord) {
    if (!draftId) return;
    setBusy(true);
    try {
      await patchThread(draftId, t.id, persona, { resolved: !t.resolved });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addComment() {
    if (!draftId) return;
    const body = newComment.trim();
    if (!body) return;
    setBusy(true);
    try {
      await createThread(draftId, persona, { kind: "comment", body });
      setNewComment("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-sunken p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">
          Threads {openCount > 0 && <span className="ml-1 text-accent">({openCount} open)</span>}
        </div>
        <div className="flex gap-0.5 rounded-lg border border-border bg-surface-raised p-0.5 text-[10px]">
          {(["open", "resolved", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-1.5 py-0.5 uppercase tracking-wide transition-colors ${
                filter === f ? "bg-accent text-white" : "text-text-muted hover:text-text"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {!draftId && (
        <p className="text-[11px] text-text-muted">Open a draft to view threads.</p>
      )}

      {draftId && filtered.length === 0 && (
        <p className="text-[11px] text-text-muted">
          {filter === "resolved" ? "No resolved threads." : "No threads yet."}
        </p>
      )}

      <ul className="max-h-60 space-y-1.5 overflow-auto">
        {filtered.map((t) => (
          <li
            key={t.id}
            className={`rounded-lg border p-1.5 text-[11px] ${
              t.resolved
                ? "border-border bg-surface-raised/60 opacity-60"
                : t.kind === "review_reason"
                  ? "border-status-changes-border bg-status-changes-surface/40"
                  : "border-border bg-surface-raised"
            }`}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <KindTag kind={t.kind} />
              <span className="truncate text-text-muted">
                {t.author_name ?? t.author_employee_id ?? "unknown"}
              </span>
              <button
                type="button"
                onClick={() => void toggleResolved(t)}
                disabled={busy}
                className="ml-auto rounded border border-border-strong px-1.5 py-0.5 text-[9px] text-text-muted transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                {t.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
            <div className="whitespace-pre-wrap text-text">{t.body}</div>
            {t.created_at && (
              <div className="mt-1 text-[9px] text-text-muted">{t.created_at.slice(0, 19)}</div>
            )}
          </li>
        ))}
      </ul>

      {canComment && draftId && (
        <div className="mt-2 space-y-1">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            rows={2}
            placeholder="Add a comment on this draft…"
            className="w-full rounded-lg border border-border-strong bg-surface-raised p-1.5 text-[11px] text-text outline-none focus:border-accent"
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy || !newComment.trim()}
              onClick={() => void addComment()}
              className="rounded-lg bg-accent px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "…" : "Post"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-1 text-[10px] text-status-rejected-text">{error}</p>
      )}
    </div>
  );
}
