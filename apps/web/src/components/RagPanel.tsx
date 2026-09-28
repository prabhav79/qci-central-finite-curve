"use client";

import { useEffect, useState } from "react";
import {
  type CorpusHit,
  type PersonaKey,
  corpusStats,
  ragQuery,
} from "@/lib/cfcApi";

type Msg = {
  role: "user" | "assistant";
  content: string;
  provider?: string;
  citations?: CorpusHit[];
};

export function RagPanel({
  persona,
  onInsertCitation,
  canInsert,
}: {
  persona: PersonaKey;
  onInsertCitation?: (hit: CorpusHit) => Promise<void> | void;
  canInsert?: boolean;
}) {
  const [stats, setStats] = useState<string>("Loading corpus...");
  const [input, setInput] = useState("What are typical CPGRAMS PMU deliverables?");
  const [busy, setBusy] = useState(false);
  const [inserting, setInserting] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void corpusStats()
      .then((s) => {
        const kinds = s.by_kind
          ? Object.entries(s.by_kind).map(([k, v]) => k + ":" + v).join(", ")
          : "";
        setStats(s.documents + " docs / " + s.chunks + " chunks" + (kinds ? " (" + kinds + ")" : ""));
      })
      .catch((e) => setStats("Corpus unavailable: " + (e instanceof Error ? e.message : String(e))));
  }, []);

  async function onAsk() {
    const q = input.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setMsgs((m) => [...m, { role: "user", content: q }]);
    try {
      const res = await ragQuery(persona, q, { limit: 6 });
      setMsgs((m) => [...m, { role: "assistant", content: res.answer, provider: res.provider, citations: res.citations }]);
      if (res.error) setError(res.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      await onInsertCitation(hit);
      setNotice("Inserted citation from: " + hit.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInserting(null);
    }
  }

  return (
    <div className="flex h-full min-h-[280px] flex-col gap-2 rounded-xl border border-border bg-surface-raised p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-text">Institutional RAG</div>
          <div className="text-[11px] text-text-muted">{stats}</div>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-text-muted">early</div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto rounded-lg border border-border bg-surface-sunken p-2 text-xs">
        {msgs.length === 0 && (
          <p className="text-text-muted">
            Ask about work orders, deliverables, ministries, or PMU extensions. Insert citations into the open SuperDoc draft when editing is allowed.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "rounded-lg bg-accent/10 p-2 text-text" : "rounded-lg bg-surface-raised p-2 text-text"}>
            <div className="mb-1 text-[10px] uppercase text-text-muted">{m.role}{m.provider ? " / " + m.provider : ""}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <ul className="mt-2 space-y-2 border-t border-border pt-2 text-[10px] text-text-muted">
                {m.citations.slice(0, 6).map((c) => (
                  <li key={c.chunk_id} className="space-y-1">
                    <div><span className="font-mono text-text">[{c.score}]</span> {c.title} - {c.ministry}{c.kind ? " (" + c.kind + ")" : ""}</div>
                    <div className="line-clamp-2 text-text-muted">{c.text}</div>
                    {canInsert && onInsertCitation && (
                      <button type="button" disabled={inserting === c.chunk_id} onClick={() => void handleInsert(c)} className="rounded border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-50">
                        {inserting === c.chunk_id ? "Inserting..." : "Insert into draft"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {notice && <div className="rounded-lg border border-status-approved-border bg-status-approved-surface p-2 text-[11px] text-status-approved-text">{notice}</div>}
      {error && <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-[11px] text-status-rejected-text">{error}</div>}
      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onAsk(); } }} placeholder="Ask the institutional corpus..." className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-xs text-text outline-none focus:border-accent" />
        <button type="button" disabled={busy || !input.trim()} onClick={() => void onAsk()} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50">{busy ? "..." : "Ask"}</button>
      </div>
    </div>
  );
}
