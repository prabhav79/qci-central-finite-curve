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
    <div className="flex h-full min-h-[280px] flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-zinc-100">Institutional RAG</div>
          <div className="text-[11px] text-zinc-500">{stats}</div>
        </div>
        <div className="text-[10px] uppercase tracking-wide text-zinc-600">early</div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto rounded border border-zinc-900 bg-zinc-900/40 p-2 text-xs">
        {msgs.length === 0 && (
          <p className="text-zinc-500">
            Ask about work orders, deliverables, ministries, or PMU extensions. Insert citations into the open SuperDoc draft when editing is allowed.
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={m.role === "user" ? "rounded bg-emerald-950/40 p-2 text-emerald-100" : "rounded bg-zinc-900 p-2 text-zinc-200"}>
            <div className="mb-1 text-[10px] uppercase text-zinc-500">{m.role}{m.provider ? " / " + m.provider : ""}</div>
            <div className="whitespace-pre-wrap">{m.content}</div>
            {m.citations && m.citations.length > 0 && (
              <ul className="mt-2 space-y-2 border-t border-zinc-800 pt-2 text-[10px] text-zinc-400">
                {m.citations.slice(0, 6).map((c) => (
                  <li key={c.chunk_id} className="space-y-1">
                    <div><span className="font-mono text-zinc-300">[{c.score}]</span> {c.title} - {c.ministry}{c.kind ? " (" + c.kind + ")" : ""}</div>
                    <div className="line-clamp-2 text-zinc-500">{c.text}</div>
                    {canInsert && onInsertCitation && (
                      <button type="button" disabled={inserting === c.chunk_id} onClick={() => void handleInsert(c)} className="rounded border border-sky-800 bg-sky-950/50 px-2 py-0.5 text-[10px] text-sky-200 hover:bg-sky-900 disabled:opacity-50">
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
      {notice && <div className="rounded border border-emerald-900 bg-emerald-950/40 p-2 text-[11px] text-emerald-200">{notice}</div>}
      {error && <div className="rounded border border-red-900 bg-red-950/40 p-2 text-[11px] text-red-300">{error}</div>}
      <div className="flex gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void onAsk(); } }} placeholder="Ask the institutional corpus..." className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs" />
        <button type="button" disabled={busy || !input.trim()} onClick={() => void onAsk()} className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium hover:bg-sky-600 disabled:opacity-50">{busy ? "..." : "Ask"}</button>
      </div>
    </div>
  );
}
