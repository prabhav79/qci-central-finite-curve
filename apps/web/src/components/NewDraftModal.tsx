"use client";

import { useEffect, useState } from "react";
import {
  type CorpusHit,
  type GenerationTemplate,
  type PersonaKey,
  type ReaderHighlight,
  type ServerLlm,
  corpusSearch,
  errorText,
  listGenerationTemplates,
} from "@/lib/cfcApi";
import { formatDateTimeIST } from "@/lib/dates";
import { type LlmChoice, choiceReady, missingKeyMessage } from "@/lib/llmChoice";
import { Modal } from "@/components/Modal";
import { ModelPicker } from "@/components/ModelPicker";

export type TemplateChoice =
  | { source: "catalog"; templateCode: string }
  | { source: "corpus_doc"; corpusDocId: string };

function defaultTitle(): string {
  return `Untitled draft — ${formatDateTimeIST(new Date())}`;
}

export function NewDraftModal({
  open,
  persona,
  busy,
  choice,
  onChoiceChange,
  serverLlm,
  isAdmin,
  references = [],
  onRemoveReference,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  persona: PersonaKey;
  busy?: boolean;
  choice: LlmChoice;
  onChoiceChange: (next: LlmChoice) => void;
  serverLlm: ServerLlm | null | undefined;
  isAdmin: boolean;
  /** Reader highlights this document starts from; they guide the first draft. */
  references?: ReaderHighlight[];
  onRemoveReference?: (id: number) => void;
  onCancel: () => void;
  onConfirm: (
    title: string,
    brief: string,
    template: TemplateChoice,
    confidential: boolean,
    referenceIds: number[],
  ) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [confidential, setConfidential] = useState(false);
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
    setConfidential(false);
    setBrief("");
    setError(null);
    setMode("catalog");
    setTemplateCode("BLANK");
    setDocQuery("");
    setDocResults([]);
    setSelectedDoc(null);
    void listGenerationTemplates(persona)
      .then((res) => setCatalog(res.items))
      .catch(() => setCatalog([]));
  }, [open, persona]);

  if (!open) return null;

  async function searchDocs() {
    if (!docQuery.trim()) return;
    setDocSearching(true);
    try {
      const res = await corpusSearch(docQuery.trim(), 20, persona);
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
      setError(errorText(e));
    } finally {
      setDocSearching(false);
    }
  }

  async function submit() {
    if (!title.trim()) {
      setError("Give the document a title.");
      return;
    }
    if (mode === "corpus_doc" && !selectedDoc) {
      setError("Pick a document to base the layout on, or switch back to a standard template.");
      return;
    }
    const draftBrief = confidential ? "" : brief.trim();
    if (draftBrief && !choiceReady(choice)) {
      setError(missingKeyMessage(choice));
      return;
    }
    setError(null);
    const template: TemplateChoice =
      mode === "corpus_doc"
        ? { source: "corpus_doc", corpusDocId: selectedDoc!.doc_id }
        : { source: "catalog", templateCode };
    try {
      await onConfirm(
        title.trim(),
        draftBrief,
        template,
        confidential,
        references.map((r) => r.id),
      );
    } catch (e) {
      setError(errorText(e));
    }
  }

  const selectedCatalogEntry = catalog.find((c) => c.template_code === templateCode);

  return (
    <Modal open={open} onClose={busy ? undefined : onCancel}>
      <h2 className="mb-3 text-base font-semibold text-text">New document</h2>

      {references.length > 0 && (
        <div className="mb-3 rounded-lg border border-border bg-surface-sunken p-2">
          <p className="mb-1 text-[13px] font-medium text-text">
            Starting from {references.length} highlight{references.length === 1 ? "" : "s"}
          </p>
          <ul className="max-h-36 space-y-1 overflow-auto">
            {references.map((r) => (
              <li key={r.id} className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1 border-l-[3px] border-[#F2C200] pl-2">
                  <span className="line-clamp-2 text-text">{r.quote}</span>
                  <span className="text-text-muted">
                    {r.doc_title ?? r.doc_id}, p. {r.page}
                  </span>
                </span>
                {onRemoveReference && (
                  <button
                    type="button"
                    aria-label="Remove this highlight"
                    onClick={() => onRemoveReference(r.id)}
                    className="rounded px-1 text-text-muted hover:bg-surface hover:text-text"
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-text-muted">
            {confidential
              ? "They'll be placed in the new document with their sources."
              : brief.trim()
                ? "The assistant will use these, and the documents they come from, in the first draft."
                : "They'll be placed in the new document with their sources. Or describe what you need below and the assistant will write a first draft from them."}
          </p>
        </div>
      )}

      <label className="block text-[13px] text-text-muted">
        Title
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          className="mt-1 w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
      </label>

      <div className="mt-3">
        <span className="block text-[13px] text-text-muted">Layout</span>
        <div className="mt-1 flex flex-wrap gap-1 text-[13px]">
          <button
            type="button"
            onClick={() => setMode("catalog")}
            aria-pressed={mode === "catalog"}
            className={`rounded-md px-2.5 py-1 transition-colors ${mode === "catalog" ? "bg-accent text-white" : "bg-surface-sunken text-text-muted hover:text-text"}`}
          >
            Standard template
          </button>
          <button
            type="button"
            onClick={() => setMode("corpus_doc")}
            aria-pressed={mode === "corpus_doc"}
            className={`rounded-md px-2.5 py-1 transition-colors ${mode === "corpus_doc" ? "bg-accent text-white" : "bg-surface-sunken text-text-muted hover:text-text"}`}
          >
            Base on an existing QCI document
          </button>
        </div>

        {mode === "catalog" && (
          <div className="mt-2">
            <select
              value={templateCode}
              onChange={(e) => setTemplateCode(e.target.value)}
              aria-label="Template"
              className="w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text"
            >
              {catalog.length === 0 && <option value="BLANK">Blank document</option>}
              {catalog.map((t) => (
                <option key={t.template_code} value={t.template_code}>
                  {t.template_code === "BLANK" ? "Blank document" : t.label}
                </option>
              ))}
            </select>
            {selectedCatalogEntry && selectedCatalogEntry.template_code !== "BLANK" && (
              <p className="mt-1 text-xs text-text-muted">{selectedCatalogEntry.description}</p>
            )}
          </div>
        )}

        {mode === "corpus_doc" && (
          <div className="mt-2">
            <p className="mb-1 text-xs text-text-muted">
              Only the section layout is reused (for example its Deliverables and Payment milestones).
              None of its text is copied into the new document.
            </p>
            <div className="flex gap-1">
              <input
                value={docQuery}
                onChange={(e) => setDocQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void searchDocs())}
                placeholder="e.g. CPGRAMS"
                aria-label="Search QCI documents"
                className="flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => void searchDocs()}
                disabled={docSearching || !docQuery.trim()}
                className="rounded-lg border border-border-strong px-2.5 py-1.5 text-[13px] text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
              >
                {docSearching ? "Searching…" : "Search"}
              </button>
            </div>
            {docResults.length > 0 && (
              <ul className="mt-2 max-h-36 space-y-1 overflow-auto">
                {docResults.map((hit) => (
                  <li key={hit.doc_id}>
                    <button
                      type="button"
                      onClick={() => setSelectedDoc({ doc_id: hit.doc_id, title: hit.title })}
                      className={`w-full rounded-lg border px-2 py-1 text-left text-[13px] transition-colors ${
                        selectedDoc?.doc_id === hit.doc_id
                          ? "border-status-approved-border bg-status-approved-surface text-status-approved-text"
                          : "border-border bg-surface-sunken text-text-muted hover:text-text"
                      }`}
                    >
                      {hit.title}
                      {hit.ministry && (
                        <span className="block text-xs text-text-muted">{hit.ministry}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedDoc && (
              <p className="mt-1 text-xs text-status-approved-text">Using the layout of: {selectedDoc.title}</p>
            )}
          </div>
        )}
      </div>

      <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-[13px] text-text">
        <input
          type="checkbox"
          aria-label="Confidential: draft without AI"
          checked={confidential}
          onChange={(e) => setConfidential(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        />
        <span>
          <span className="font-medium">Confidential: draft without AI</span>
          <span className="block text-xs text-text-muted">
            Nothing in this document is sent to outside AI services. This can&apos;t be changed later.
          </span>
        </span>
      </label>

      {!confidential && (
        <label className="mt-3 block text-[13px] text-text-muted">
          Describe what you need <span className="text-text-muted/80">(optional — we&apos;ll write a first draft)</span>
          <textarea
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            rows={3}
            placeholder='e.g. "Proposal for grievance redressal in Maharashtra, building on our CPGRAMS work"'
            className="mt-1 w-full resize-none rounded-lg border border-border-strong bg-surface-sunken px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
          />
          {brief.trim() && (
            <span className="mt-1 block text-xs text-status-approved-text">
              The assistant will ask a few quick questions, then write each section using QCI&apos;s past
              documents as reference.
            </span>
          )}
        </label>
      )}

      {!confidential && brief.trim() && (
        <div className="mt-2">
          <ModelPicker
            choice={choice}
            onChange={onChoiceChange}
            serverLlm={serverLlm}
            isAdmin={isAdmin}
            disabled={busy}
          />
        </div>
      )}

      {error && <p className="mt-2 text-[13px] text-status-rejected-text">{error}</p>}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy}
          className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {busy ? "Creating…" : !confidential && brief.trim() ? "Create & continue" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
