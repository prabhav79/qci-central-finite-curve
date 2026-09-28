"use client";

import { useRef, useState } from "react";
import {
  type PersonaKey,
  uploadCorpusFile,
  uploadCorpusTemplate,
  reindexCorpus,
  getReindexStatus,
  reclassifyCorpus,
  recomputeGraph,
} from "@/lib/cfcApi";

type Mode = "wo" | "template";

export function CorpusUploader({
  persona,
  isAdmin,
  onIngested,
}: {
  persona: PersonaKey;
  isAdmin: boolean;
  onIngested?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("wo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [templateCode, setTemplateCode] = useState("");
  const [ministry, setMinistry] = useState("");
  const [domain, setDomain] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function submit() {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setError("Pick a file first.");
      return;
    }
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      if (mode === "template") {
        if (!templateCode.trim()) {
          setError("Template code is required.");
          setBusy(false);
          return;
        }
        const r = await uploadCorpusTemplate(persona, f, templateCode.trim().toUpperCase());
        setStatus(`Template ${r.template_code} saved → ${r.path}`);
      } else {
        const r = await uploadCorpusFile(persona, f, { ministry, domain });
        setStatus(
          `Ingested ${r.doc_id} (${r.chunks} chunks) into ${r.division_code}${
            r.changed ? "" : " · unchanged"
          }`,
        );
      }
      if (fileRef.current) fileRef.current.value = "";
      onIngested?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReindex() {
    setBusy(true);
    setError(null);
    setStatus("Enqueuing changed files…");
    try {
      const r = await reindexCorpus(persona);
      if (!r.accepted) {
        setStatus(`Reindex not started: ${r.reason ?? "unknown reason"}`);
        return;
      }
      // Job queue runs in the background (survives a Railway redeploy) —
      // poll for completion instead of expecting a synchronous result.
      for (let i = 0; i < 150; i++) {
        await new Promise((r2) => setTimeout(r2, 2000));
        const st = await getReindexStatus(persona);
        const { pending = 0, running = 0, done = 0, error: errCount = 0 } = st.jobs;
        setStatus(`Reindexing… done=${done} pending=${pending} running=${running}${errCount ? ` error=${errCount}` : ""}`);
        if (pending === 0 && running === 0) {
          setStatus(
            `Reindex done: ${done} indexed${errCount ? `, ${errCount} failed` : ""} · ` +
              `RunPulse pages used ${st.runpulse_pages_used_total}${st.runpulse_page_cap ? `/${st.runpulse_page_cap}` : ""}`,
          );
          onIngested?.();
          return;
        }
      }
      setStatus("Reindex still running in the background — check back later.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onReclassify() {
    setBusy(true);
    setError(null);
    setStatus("Reclassifying corpus documents…");
    try {
      const r = await reclassifyCorpus(persona);
      setStatus(`Reclassified: ${r.changed}/${r.documents} document(s) updated.`);
      onIngested?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRecomputeGraph() {
    setBusy(true);
    setError(null);
    setStatus("Recomputing knowledge-graph edges…");
    try {
      const r = await recomputeGraph(persona);
      setStatus(`Graph recomputed: ${r.edges_upserted} edge(s) across ${r.documents} document(s).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-zinc-500">Corpus upload</div>
        {isAdmin && (
          <div className="flex gap-0.5 rounded border border-zinc-700 bg-zinc-950 p-0.5 text-[10px]">
            {(["wo", "template"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-1.5 py-0.5 uppercase tracking-wide ${
                  mode === m ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {m === "wo" ? "Work order" : "Template"}
              </button>
            ))}
          </div>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={mode === "template" ? ".docx" : ".docx,.pdf"}
        className="block w-full text-[11px] text-zinc-300 file:mr-2 file:rounded file:border-0 file:bg-zinc-800 file:px-2 file:py-1 file:text-[11px] file:text-zinc-200 hover:file:bg-zinc-700"
      />

      {mode === "template" ? (
        <input
          value={templateCode}
          onChange={(e) => setTemplateCode(e.target.value)}
          placeholder="Template code (e.g. WO_EXTENSION)"
          className="mt-1.5 w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100"
        />
      ) : (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <input
            value={ministry}
            onChange={(e) => setMinistry(e.target.value)}
            placeholder="Ministry (optional)"
            className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100"
          />
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="Domain tag (optional)"
            className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-100"
          />
        </div>
      )}

      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded bg-emerald-700 px-2 py-1 text-[11px] font-medium hover:bg-emerald-600 disabled:opacity-50"
        >
          {busy ? "…" : mode === "template" ? "Upload template" : "Upload & index"}
        </button>
        {isAdmin && (
          <div className="ml-auto flex gap-1">
            <button
              type="button"
              onClick={() => void onReindex()}
              disabled={busy}
              className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              title="Rebuild the entire corpus index (~1 min)"
            >
              Reindex all
            </button>
            <button
              type="button"
              onClick={() => void onReclassify()}
              disabled={busy}
              className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              title="Re-run domain/ministry classification against already-ingested documents (cheap — no re-extraction or OCR)"
            >
              Reclassify
            </button>
            <button
              type="button"
              onClick={() => void onRecomputeGraph()}
              disabled={busy}
              className="rounded border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              title="Recompute knowledge-graph related-document edges"
            >
              Recompute graph
            </button>
          </div>
        )}
      </div>

      {status && (
        <p className="mt-1 whitespace-pre-wrap text-[10px] text-emerald-300">{status}</p>
      )}
      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
    </div>
  );
}
