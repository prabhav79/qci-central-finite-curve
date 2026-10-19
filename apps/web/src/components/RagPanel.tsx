"use client";

import { useEffect, useState } from "react";
import {
  type CorpusHit,
  type PersonaKey,
  corpusStats,
  errorText,
  ragQuery,
} from "@/lib/cfcApi";

type Msg = {
  role: "user" | "assistant";
  content: string;
  citations?: CorpusHit[];
};

export function RagPanel({
  persona,
  onInsertCitation,
  canInsert,
}: {
  persona: PersonaKey;
  /** Resolves to the message to show (e.g. "Added to the document"). */
  onInsertCitation?: (hit: CorpusHit) => Promise<string | void> | string | void;
  canInsert?: boolean;
}) {
  const [docCount, setDocCount] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [inserting, setInserting] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void corpusStats()
      .then((s) => setDocCount(s.documents))
      .catch(() => setDocCount(null));
  }, []);

  async function onAsk() {
    const q = input.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setMsgs((m) => [...m, { role: "user", content: q }]);
    setInput("");
    try {
      const res = await ragQuery(persona, q, { limit: 6 });
      setMsgs((m) => [...m, { role: "assistant", content: res.answer, citations: res.citations }]);
      if (res.error) {
        setNotice("A written answer isn't available right now, so the most relevant passages are shown.");
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleInsert(hit: CorpusHit) {
    if (!onInsertCitation) return;
    setInserting(hit.chunk_id);
    setError(null);
    setNotice(null);
    try {
      const msg = await onInsertCitation(hit);
      setNotice(msg || "Added to the document");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setInserting(null);
    }
  }

  return (
    <div className="flex h-full min-h-[280px] flex-col gap-2 text-[13px]">
      <div>
        <h2 className="text-sm font-semibold text-text">Ask QCI&apos;s knowledge base</h2>
        {docCount != null && (
          <p className="text-xs text-text-muted">Answers from {docCount} past QCI documents</p>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto rounded-lg border border-border bg-surface-sunken p-2">
        {msgs.length === 0 && (
          <p className="text-text-muted">
            Ask about past work orders, deliverables, ministries or project extensions. You can add a
            quoted excerpt to the open document.
          </p>
        )}
        {msgs.map((m, i) => (
          <div
            key={i}
            className={m.role === "user" ? "rounded-lg bg-accent/10 p-2 text-text" : "rounded-lg bg-surface-raised p-2 text-text"}
          >
            {m.role === "user" && <div className="mb-0.5 text-xs font-medium text-text-muted">You asked</div>}
            <div className="whitespace-pre-wrap">{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <div className="mt-2 border-t border-border pt-2">
                <div className="mb-1 text-xs font-medium text-text-muted">Sources</div>
                <ul className="space-y-2">
                  {m.citations.slice(0, 6).map((c) => (
                    <li key={c.chunk_id} className="space-y-1">
                      <div className="text-text">
                        <span className="font-medium">{c.title}</span>
                        {c.ministry && <span className="text-text-muted"> · {c.ministry}</span>}
                      </div>
                      <div className="line-clamp-2 text-xs text-text-muted">{c.text}</div>
                      {canInsert && onInsertCitation && (
                        <button
                          type="button"
                          disabled={inserting === c.chunk_id}
                          onClick={() => void handleInsert(c)}
                          className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
                        >
                          {inserting === c.chunk_id ? "Adding…" : "Add to document"}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
      {notice && (
        <div className="rounded-lg border border-status-approved-border bg-status-approved-surface p-2 text-status-approved-text">
          {notice}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-status-rejected-text">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void onAsk();
            }
          }}
          placeholder="Type a question…"
          aria-label="Your question"
          className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-[13px] text-text outline-none focus:border-accent"
        />
        <button
          type="button"
          disabled={busy || !input.trim()}
          onClick={() => void onAsk()}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Asking…" : "Ask"}
        </button>
      </div>
    </div>
  );
}
