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
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function handleFiles(files: FileList | null) {
    const f = files?.[0];
    if (!f || !fileRef.current) return;
    const dt = new DataTransfer();
    dt.items.add(f);
    fileRef.current.files = dt.files;
    setFileName(f.name);
  }

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
      setFileName(null);
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
    <div className="rounded-lg border border-border bg-surface-sunken p-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-text-muted">Corpus upload</div>
        {isAdmin && (
          <div className="flex gap-0.5 rounded-lg border border-border bg-surface-raised p-0.5 text-[10px]">
            {(["wo", "template"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`rounded px-1.5 py-0.5 uppercase tracking-wide transition-colors ${
                  mode === m ? "bg-accent text-white" : "text-text-muted hover:text-text"
                }`}
              >
                {m === "wo" ? "Work order" : "Template"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        onClick={() => fileRef.current?.click()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border-2 border-dashed p-3 text-center transition-colors ${
          dragOver ? "border-accent bg-accent/5" : "border-border-strong hover:border-accent/50"
        }`}
      >
        <input
          ref={fileRef}
          type="file"
          accept={mode === "template" ? ".docx" : ".docx,.pdf"}
          onChange={(e) => handleFiles(e.target.files)}
          className="hidden"
        />
        <p className="text-[11px] text-text">
          {fileName ? (
            <span className="font-medium">{fileName}</span>
          ) : (
            "Drop a file here, or click to browse"
          )}
        </p>
        <p className="text-[10px] text-text-muted">{mode === "template" ? "DOCX" : "DOCX or PDF"}</p>
      </div>

      {mode === "template" ? (
        <input
          value={templateCode}
          onChange={(e) => setTemplateCode(e.target.value)}
          placeholder="Template code (e.g. WO_EXTENSION)"
          className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface-raised px-1.5 py-1 text-[11px] text-text outline-none focus:border-accent"
        />
      ) : (
        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
          <input
            value={ministry}
            onChange={(e) => setMinistry(e.target.value)}
            placeholder="Ministry (optional)"
            className="rounded-lg border border-border-strong bg-surface-raised px-1.5 py-1 text-[11px] text-text outline-none focus:border-accent"
          />
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="Domain tag (optional)"
            className="rounded-lg border border-border-strong bg-surface-raised px-1.5 py-1 text-[11px] text-text outline-none focus:border-accent"
          />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-surface-raised p-1">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "…" : mode === "template" ? "Upload template" : "Upload & index"}
        </button>
        {isAdmin && (
          <>
            <div className="mx-0.5 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => void onReindex()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-sunken hover:text-text disabled:opacity-50"
              title="Rebuild the entire corpus index (~1 min)"
            >
              Reindex all
            </button>
            <button
              type="button"
              onClick={() => void onReclassify()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-sunken hover:text-text disabled:opacity-50"
              title="Re-run domain/ministry classification against already-ingested documents (cheap — no re-extraction or OCR)"
            >
              Reclassify
            </button>
            <button
              type="button"
              onClick={() => void onRecomputeGraph()}
              disabled={busy}
              className="rounded-md px-2 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-sunken hover:text-text disabled:opacity-50"
              title="Recompute knowledge-graph related-document edges"
            >
              Recompute graph
            </button>
          </>
        )}
      </div>

      {status && (
        <p className="mt-1 whitespace-pre-wrap text-[10px] text-status-approved-text">{status}</p>
      )}
      {error && <p className="mt-1 text-[10px] text-status-rejected-text">{error}</p>}
    </div>
  );
}
