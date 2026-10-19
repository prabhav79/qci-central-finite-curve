"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type PersonaKey,
  type ThreadRecord,
  createThread,
  errorText,
  fetchThreads,
  patchThread,
} from "@/lib/cfcApi";
import { personName } from "@/lib/copy";
import { formatDateTimeIST } from "@/lib/dates";

const FILTER_LABELS: Record<"open" | "resolved" | "all", string> = {
  open: "Open",
  resolved: "Resolved",
  all: "All",
};

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
    review_reason: "Review note",
    comment: "Comment",
    tracked_change: "Suggested change",
  };
  return (
    <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium ${tone[kind]}`}>
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
      setError(errorText(e));
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
      setError(errorText(e));
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
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="text-[13px]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">
          Comments {openCount > 0 && <span className="font-normal text-accent">({openCount} open)</span>}
        </h2>
        <div className="flex gap-0.5 rounded-lg border border-border bg-surface-raised p-0.5 text-xs">
          {(["open", "resolved", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`rounded px-2 py-0.5 transition-colors ${
                filter === f ? "bg-accent text-white" : "text-text-muted hover:text-text"
              }`}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      </div>

      {!draftId && (
        <p className="text-text-muted">Open a document to see its comments.</p>
      )}

      {draftId && filtered.length === 0 && (
        <p className="text-text-muted">
          {filter === "resolved" ? "No resolved comments." : "No comments yet."}
        </p>
      )}

      <ul className="space-y-1.5">
        {filtered.map((t) => (
          <li
            key={t.id}
            className={`rounded-lg border p-2 ${
              t.resolved
                ? "border-border bg-surface-raised/60 opacity-60"
                : t.kind === "review_reason"
                  ? "border-status-changes-border bg-status-changes-surface/40"
                  : "border-border bg-surface-raised"
            }`}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <KindTag kind={t.kind} />
              <span className="truncate text-xs text-text-muted">
                {personName(t.author_name, t.author_employee_id)}
              </span>
              <button
                type="button"
                onClick={() => void toggleResolved(t)}
                disabled={busy}
                className="ml-auto rounded border border-border-strong px-1.5 py-0.5 text-xs text-text-muted transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                {t.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
            <div className="whitespace-pre-wrap text-text">{t.body}</div>
            {t.created_at && (
              <div className="mt-1 text-xs text-text-muted">{formatDateTimeIST(t.created_at)}</div>
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
            placeholder="Add a comment…"
            aria-label="Add a comment"
            className="w-full rounded-lg border border-border-strong bg-surface-raised p-2 text-[13px] text-text outline-none focus:border-accent"
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy || !newComment.trim()}
              onClick={() => void addComment()}
              className="rounded-lg bg-accent px-3 py-1 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? "Posting…" : "Post"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-1 text-status-rejected-text">{error}</p>
      )}
    </div>
  );
}
