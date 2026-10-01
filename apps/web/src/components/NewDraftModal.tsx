"use client";

import { useEffect, useState } from "react";
import {
  type CorpusHit,
  type GenerationTemplate,
  type PersonaKey,
  type Provider,
  corpusSearch,
  listGenerationTemplates,
  loadStoredApiKey,
  storeApiKey,
} from "@/lib/cfcApi";
import { Modal } from "@/components/Modal";

export type TemplateChoice =
  | { source: "catalog"; templateCode: string }
  | { source: "corpus_doc"; corpusDocId: string };

export type GenerationProviderChoice = { provider: Provider; apiKey: string; model: string };

const PROVIDERS: Provider[] = ["mock", "gemini", "openai", "anthropic"];

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
  onConfirm: (
    title: string,
    brief: string,
    template: TemplateChoice,
    generationProvider: GenerationProviderChoice,
  ) => Promise<void> | void;
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
  const [genProvider, setGenProvider] = useState<Provider>("mock");
  const [genApiKey, setGenApiKey] = useState("");
  const [genModel, setGenModel] = useState("");

  function selectProvider(p: Provider) {
    setGenProvider(p);
    setGenModel("");
    setGenApiKey(p === "mock" ? "" : loadStoredApiKey(p));
  }

  function updateGenApiKey(value: string) {
    setGenApiKey(value);
    storeApiKey(genProvider, value);
  }

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
    setGenProvider("mock");
    setGenApiKey("");
    setGenModel("");
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
    if (brief.trim() && genProvider !== "mock" && !genApiKey.trim()) {
      setError(`Enter your ${genProvider} API key, or switch to Mock for a no-key test run.`);
      return;
    }
    setError(null);
    const template: TemplateChoice =
      mode === "corpus_doc"
        ? { source: "corpus_doc", corpusDocId: selectedDoc!.doc_id }
        : { source: "catalog", templateCode };
    try {
      await onConfirm(title.trim(), brief.trim(), template, {
        provider: genProvider,
        apiKey: genApiKey.trim(),
        model: genModel.trim(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const selectedCatalogEntry = catalog.find((c) => c.template_code === templateCode);

  return (
    <Modal open={open} onClose={busy ? undefined : onCancel}>
      <h2 className="mb-3 text-sm font-semibold text-text">New draft</h2>

      <label className="block text-xs text-text-muted">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          className="mt-1 w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
      </label>

      <div className="mt-3">
        <span className="block text-xs text-text-muted">Structure</span>
        <div className="mt-1 flex gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => setMode("catalog")}
            className={`rounded-md px-2 py-1 transition-colors ${mode === "catalog" ? "bg-accent text-white" : "bg-surface-sunken text-text-muted hover:text-text"}`}
          >
            Fixed format
          </button>
          <button
            type="button"
            onClick={() => setMode("corpus_doc")}
            className={`rounded-md px-2 py-1 transition-colors ${mode === "corpus_doc" ? "bg-accent text-white" : "bg-surface-sunken text-text-muted hover:text-text"}`}
          >
            Base on an existing QCI document
          </button>
        </div>

        {mode === "catalog" && (
          <div className="mt-2">
            <select
              value={templateCode}
              onChange={(e) => setTemplateCode(e.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text"
            >
              {catalog.length === 0 && <option value="BLANK">Blank canvas</option>}
              {catalog.map((t) => (
                <option key={t.template_code} value={t.template_code}>
                  {t.label}
                </option>
              ))}
            </select>
            {selectedCatalogEntry && (
              <p className="mt-1 text-[11px] text-text-muted">{selectedCatalogEntry.description}</p>
            )}
          </div>
        )}

        {mode === "corpus_doc" && (
          <div className="mt-2">
            <p className="mb-1 text-[11px] text-text-muted">
              Only the document&apos;s section shape is reused (e.g. its Deliverables / Payment
              Milestones breakdown) — its actual content is never copied into the new draft.
            </p>
            <div className="flex gap-1">
              <input
                value={docQuery}
                onChange={(e) => setDocQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void searchDocs())}
                placeholder="e.g. CPGRAMS"
                className="flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void searchDocs()}
                disabled={docSearching || !docQuery.trim()}
                className="rounded-lg border border-border-strong px-2 py-1.5 text-xs text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
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
                      className={`w-full rounded-lg border px-2 py-1 text-left text-[11px] transition-colors ${
                        selectedDoc?.doc_id === hit.doc_id
                          ? "border-status-approved-border bg-status-approved-surface text-status-approved-text"
                          : "border-border bg-surface-sunken text-text-muted hover:text-text"
                      }`}
                    >
                      {hit.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedDoc && (
              <p className="mt-1 text-[11px] text-status-approved-text">Using structure from: {selectedDoc.title}</p>
            )}
          </div>
        )}
      </div>

      <label className="mt-3 block text-xs text-text-muted">
        Describe what you need <span className="text-text-muted/70">(optional — generates a first draft)</span>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={3}
          placeholder='e.g. "Proposal for grievance redressal in Maharashtra, building on our CPGRAMS work"'
          className="mt-1 w-full resize-none rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
        {brief.trim() && (
          <span className="mt-1 block text-[11px] text-status-approved-text">
            The agent will ask a few clarifying questions, then draft each section grounded in the
            corpus for you to review.
          </span>
        )}
      </label>

      {brief.trim() && (
        <div className="mt-2">
          <span className="block text-xs text-text-muted">Model</span>
          <div className="mt-1 grid grid-cols-4 gap-1 text-[10px]">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => selectProvider(p)}
                className={`rounded-md px-1 py-1 uppercase tracking-wide transition-colors ${
                  genProvider === p ? "bg-agent text-white" : "bg-surface-sunken text-text-muted hover:text-text"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          {genProvider !== "mock" && (
            <>
              <input
                type="password"
                value={genApiKey}
                onChange={(e) => updateGenApiKey(e.target.value)}
                placeholder={`${genProvider} API key (BYOK — remembered in this browser only)`}
                className="mt-1.5 w-full rounded-lg border border-border-strong bg-surface-sunken px-1.5 py-1 font-mono text-[10px] text-text outline-none focus:border-accent"
              />
              <input
                value={genModel}
                onChange={(e) => setGenModel(e.target.value)}
                placeholder="model (optional — uses the provider default)"
                className="mt-1 w-full rounded-lg border border-border-strong bg-surface-sunken px-1.5 py-1 text-[10px] text-text outline-none focus:border-accent"
              />
            </>
          )}
        </div>
      )}

      {error && <p className="mt-2 text-xs text-status-rejected-text">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-xs text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Creating…" : brief.trim() ? "Create & continue" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
