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
    review_reason: "bg-orange-900 text-orange-200 border border-orange-800",
    comment: "bg-cyan-900 text-cyan-200 border border-cyan-800",
    tracked_change: "bg-violet-900 text-violet-200 border border-violet-800",
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
    <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          Threads {openCount > 0 && <span className="ml-1 text-cyan-400">({openCount} open)</span>}
        </div>
        <div className="flex gap-0.5 rounded border border-zinc-700 bg-zinc-950 p-0.5 text-[10px]">
          {(["open", "resolved", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-1.5 py-0.5 uppercase tracking-wide ${
                filter === f ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {!draftId && (
        <p className="text-[11px] text-zinc-500">Open a draft to view threads.</p>
      )}

      {draftId && filtered.length === 0 && (
        <p className="text-[11px] text-zinc-600">
          {filter === "resolved" ? "No resolved threads." : "No threads yet."}
        </p>
      )}

      <ul className="max-h-60 space-y-1.5 overflow-auto">
        {filtered.map((t) => (
          <li
            key={t.id}
            className={`rounded border p-1.5 text-[11px] ${
              t.resolved
                ? "border-zinc-800 bg-zinc-950/60 opacity-60"
                : t.kind === "review_reason"
                  ? "border-orange-900 bg-orange-950/30"
                  : "border-zinc-800 bg-zinc-950"
            }`}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <KindTag kind={t.kind} />
              <span className="truncate text-zinc-400">
                {t.author_name ?? t.author_employee_id ?? "unknown"}
              </span>
              <button
                type="button"
                onClick={() => void toggleResolved(t)}
                disabled={busy}
                className="ml-auto rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              >
                {t.resolved ? "Reopen" : "Resolve"}
              </button>
            </div>
            <div className="whitespace-pre-wrap text-zinc-200">{t.body}</div>
            {t.created_at && (
              <div className="mt-1 text-[9px] text-zinc-600">{t.created_at.slice(0, 19)}</div>
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
            className="w-full rounded border border-zinc-700 bg-zinc-950 p-1.5 text-[11px] text-zinc-100 focus:border-blue-500 focus:outline-none"
          />
          <div className="flex justify-end">
            <button
              type="button"
              disabled={busy || !newComment.trim()}
              onClick={() => void addComment()}
              className="rounded bg-cyan-700 px-2 py-1 text-[10px] font-medium hover:bg-cyan-600 disabled:opacity-50"
            >
              {busy ? "…" : "Post"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
