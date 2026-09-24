"use client";

import { useEffect, useState } from "react";
import { type PersonaKey, type TemplateItem, listTemplates } from "@/lib/cfcApi";

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
  onConfirm: (title: string, templateCode: string) => Promise<void> | void;
}) {
  const [title, setTitle] = useState("");
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [templateCode, setTemplateCode] = useState("WO_EXTENSION");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(defaultTitle());
    setError(null);
    void listTemplates(persona).then((res) => {
      setTemplates(res.items);
      if (res.items.length > 0) setTemplateCode(res.items[0].template_code);
    });
  }, [open, persona]);

  if (!open) return null;

  async function submit() {
    if (!title.trim()) {
      setError("Give the draft a title.");
      return;
    }
    setError(null);
    try {
      await onConfirm(title.trim(), templateCode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-zinc-700 bg-zinc-950 p-4 shadow-xl">
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

        <label className="mt-3 block text-xs text-zinc-400">
          Template{" "}
          {templates.length <= 1 && (
            <span className="text-zinc-600">
              (only one registered — add more in{" "}
              <a href="/studio/templates" className="underline">
                Templates
              </a>
              )
            </span>
          )}
          <select
            value={templateCode}
            onChange={(e) => setTemplateCode(e.target.value)}
            disabled={templates.length <= 1}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 disabled:opacity-60"
          >
            {templates.length === 0 && <option value="WO_EXTENSION">WO_EXTENSION</option>}
            {templates.map((t) => (
              <option key={t.template_code} value={t.template_code}>
                {t.template_code} ({t.filename})
              </option>
            ))}
          </select>
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
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
