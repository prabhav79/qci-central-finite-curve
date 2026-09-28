"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PERSONAS,
  type PersonaKey,
  type TemplateItem,
  listTemplates,
  uploadCorpusTemplate,
} from "@/lib/cfcApi";
import { EmptyState } from "@/components/EmptyState";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function TemplatesAdmin() {
  const [persona, setPersona] = useState<PersonaKey>("admin");
  const [items, setItems] = useState<TemplateItem[]>([]);
  const [templateCode, setTemplateCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const isAdmin = persona === "admin";

  const load = useCallback(
    async (p: PersonaKey = persona) => {
      setError(null);
      try {
        const res = await listTemplates(p);
        setItems(res.items);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [persona],
  );

  useEffect(() => {
    void load(persona);
  }, [persona, load]);

  async function upload() {
    const f = fileRef.current?.files?.[0];
    if (!f) {
      setError("Pick a .docx file first.");
      return;
    }
    if (!templateCode.trim()) {
      setError("Template code is required.");
      return;
    }
    setError(null);
    setStatus(null);
    setBusy(true);
    try {
      const r = await uploadCorpusTemplate(persona, f, templateCode.trim().toUpperCase());
      setStatus(`Uploaded ${r.template_code} → ${r.path}`);
      setTemplateCode("");
      if (fileRef.current) fileRef.current.value = "";
      await load(persona);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6 text-text">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Template library</h1>
        <p className="text-xs text-text-muted">
          DOCX substrates makers pick from when creating a new draft. Admin persona to upload.
        </p>
        <label className="ml-auto text-xs text-text-muted">
          Persona
          <select
            className="ml-2 rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text"
            value={persona}
            onChange={(e) => setPersona(e.target.value as PersonaKey)}
          >
            {Object.entries(PERSONAS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text">{error}</div>
      )}
      {status && (
        <div className="rounded-lg border border-status-approved-border bg-status-approved-surface p-3 text-sm text-status-approved-text">
          {status}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wide text-text-muted">
          Registered · {items.length}
        </h2>
        <ul className="space-y-2">
          {items.length === 0 && (
            <li>
              <EmptyState>No templates registered yet.</EmptyState>
            </li>
          )}
          {items.map((t) => (
            <li
              key={t.template_code}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface-raised p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-text">{t.template_code}</div>
                <div className="text-[11px] text-text-muted">
                  {t.filename} · {fmtBytes(t.bytes)} · modified {t.modified_at.slice(0, 19)}
                </div>
              </div>
              <span className="rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] text-text-muted">
                {t.path}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section
        className={`rounded-lg border p-3 ${
          isAdmin ? "border-border bg-surface-raised" : "border-dashed border-border-strong opacity-60"
        }`}
      >
        <h2 className="mb-2 text-xs uppercase tracking-wide text-text-muted">
          Upload new template {isAdmin ? "" : "(admin persona required)"}
        </h2>
        <input
          ref={fileRef}
          type="file"
          accept=".docx"
          disabled={!isAdmin}
          className="block w-full text-xs text-text file:mr-2 file:rounded file:border-0 file:bg-surface-sunken file:px-2 file:py-1 file:text-xs file:text-text hover:file:bg-border"
        />
        <input
          value={templateCode}
          onChange={(e) => setTemplateCode(e.target.value)}
          placeholder="TEMPLATE_CODE (e.g. WO_EXTENSION)"
          disabled={!isAdmin}
          className="mt-2 w-full rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-sm text-text outline-none focus:border-accent disabled:opacity-50"
        />
        <div className="mt-2">
          <button
            type="button"
            onClick={() => void upload()}
            disabled={!isAdmin || busy}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload template"}
          </button>
        </div>
      </section>
    </div>
  );
}
