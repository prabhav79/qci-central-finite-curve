"use client";

import { useEffect, useState } from "react";
import {
  type CorpusHit,
  type GenerationTemplate,
  type PersonaKey,
  corpusSearch,
  listGenerationTemplates,
} from "@/lib/cfcApi";

export type TemplateChoice =
  | { source: "catalog"; templateCode: string }
  | { source: "corpus_doc"; corpusDocId: string };

function defaultTitle(): string {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  return `Untitled draft — ${stamp}`;
}

export function NewDraftModal({
  open,
  persona,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  persona: PersonaKey;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (title: string, brief: string, template: TemplateChoice) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [catalog, setCatalog] = useState<GenerationTemplate[]>([]);
  const [mode, setMode] = useState<"catalog" | "corpus_doc">("catalog");
  const [templateCode, setTemplateCode] = useState("BLANK");
  const [docQuery, setDocQuery] = useState("");
  const [docResults, setDocResults] = useState<CorpusHit[]>([]);
  const [docSearching, setDocSearching] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<{ doc_id: string; title: string } | null>(null);
  const [brief, setBrief] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle());
    setBrief("");
    setError(null);
    setMode("catalog");
    setTemplateCode("BLANK");
    setDocQuery("");
    setDocResults([]);
    setSelectedDoc(null);
    void listGenerationTemplates(persona).then((res) => setCatalog(res.items));
  }, [open, persona]);

  if (!open) return null;

  async function searchDocs() {
    if (!docQuery.trim()) return;
    setDocSearching(true);
    try {
      const res = await corpusSearch(docQuery.trim(), 20);
      const seen = new Set<string>();
      const deduped: CorpusHit[] = [];
      for (const hit of res.hits) {
        if (seen.has(hit.doc_id)) continue;
        seen.add(hit.doc_id);
        deduped.push(hit);
        if (deduped.length >= 6) break;
      }
      setDocResults(deduped);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDocSearching(false);
    }
  }

  async function submit() {
    if (!title.trim()) {
      setError("Give the draft a title.");
      return;
    }
    if (mode === "corpus_doc" && !selectedDoc) {
      setError("Pick a document to base the structure on, or switch back to a fixed format.");
      return;
    }
    setError(null);
    const template: TemplateChoice =
      mode === "corpus_doc"
        ? { source: "corpus_doc", corpusDocId: selectedDoc!.doc_id }
        : { source: "catalog", templateCode };
    try {
      await onConfirm(title.trim(), brief.trim(), template);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const selectedCatalogEntry = catalog.find((c) => c.template_code === templateCode);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-xl">
        <h2 className="mb-3 text-sm font-semibold text-zinc-100">New draft</h2>

        <label className="block text-xs text-zinc-400">
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-blue-500 focus:outline-none"
          />
        </label>

        <div className="mt-3">
          <span className="block text-xs text-zinc-400">Structure</span>
          <div className="mt-1 flex gap-1 text-[11px]">
            <button
              type="button"
              onClick={() => setMode("catalog")}
              className={`rounded px-2 py-1 ${mode === "catalog" ? "bg-zinc-700 text-zinc-100" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
            >
              Fixed format
            </button>
            <button
              type="button"
              onClick={() => setMode("corpus_doc")}
              className={`rounded px-2 py-1 ${mode === "corpus_doc" ? "bg-zinc-700 text-zinc-100" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"}`}
            >
              Base on an existing QCI document
            </button>
          </div>

          {mode === "catalog" && (
            <div className="mt-2">
              <select
                value={templateCode}
                onChange={(e) => setTemplateCode(e.target.value)}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100"
              >
                {catalog.length === 0 && <option value="BLANK">Blank canvas</option>}
                {catalog.map((t) => (
                  <option key={t.template_code} value={t.template_code}>
                    {t.label}
                  </option>
                ))}
              </select>
              {selectedCatalogEntry && (
                <p className="mt-1 text-[11px] text-zinc-500">{selectedCatalogEntry.description}</p>
              )}
            </div>
          )}

          {mode === "corpus_doc" && (
            <div className="mt-2">
              <p className="mb-1 text-[11px] text-zinc-500">
                Only the document&apos;s section shape is reused (e.g. its Deliverables / Payment
                Milestones breakdown) — its actual content is never copied into the new draft.
              </p>
              <div className="flex gap-1">
                <input
                  value={docQuery}
                  onChange={(e) => setDocQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void searchDocs())}
                  placeholder="e.g. CPGRAMS"
                  className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void searchDocs()}
                  disabled={docSearching || !docQuery.trim()}
                  className="rounded border border-zinc-600 px-2 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
                >
                  {docSearching ? "…" : "Search"}
                </button>
              </div>
              {docResults.length > 0 && (
                <ul className="mt-2 max-h-32 space-y-1 overflow-auto">
                  {docResults.map((hit) => (
                    <li key={hit.doc_id}>
                      <button
                        type="button"
                        onClick={() => setSelectedDoc({ doc_id: hit.doc_id, title: hit.title })}
                        className={`w-full rounded border px-2 py-1 text-left text-[11px] ${
                          selectedDoc?.doc_id === hit.doc_id
                            ? "border-emerald-600 bg-emerald-950/40 text-emerald-200"
                            : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                        }`}
                      >
                        {hit.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {selectedDoc && (
                <p className="mt-1 text-[11px] text-emerald-500">Using structure from: {selectedDoc.title}</p>
              )}
            </div>
          )}
        </div>

        <label className="mt-3 block text-xs text-zinc-400">
          Describe what you need <span className="text-zinc-600">(optional — generates a first draft)</span>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder='e.g. "Proposal for grievance redressal in Maharashtra, building on our CPGRAMS work"'
            className="mt-1 w-full resize-none rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none"
          />
          {brief.trim() && (
            <span className="mt-1 block text-[11px] text-emerald-500">
              The agent will draft each section grounded in the corpus, then open in the editor for review.
            </span>
          )}
        </label>

        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-zinc-600 px-3 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "Creating…" : brief.trim() ? "Create & generate" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
