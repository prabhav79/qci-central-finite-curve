"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type DiffResponse, type PersonaKey, fetchDraftDiff } from "@/lib/cfcApi";

function BlockRow({ tag, lines, side }: { tag: string; lines: string[]; side: "a" | "b" }) {
  if (!lines.length) return null;
  const tone =
    tag === "equal"
      ? "text-text-muted"
      : tag === "delete" || (tag === "replace" && side === "a")
        ? "bg-status-rejected-surface/60 text-status-rejected-text border-l-2 border-status-rejected-border pl-2"
        : "bg-status-approved-surface/60 text-status-approved-text border-l-2 border-status-approved-border pl-2";
  const prefix = tag === "equal" ? "  " : side === "a" ? "- " : "+ ";
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => (
        <div key={i} className={`whitespace-pre-wrap font-mono text-[11px] ${tone}`}>
          <span className="mr-1 select-none text-text-muted">{prefix}</span>
          {line || " "}
        </div>
      ))}
    </div>
  );
}

function CollapsibleUnchanged({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-[11px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-text-muted transition-colors hover:text-text"
      >
        <svg
          viewBox="0 0 24 24"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 6l6 6-6 6" />
        </svg>
        {lines.length} unchanged line{lines.length === 1 ? "" : "s"}
      </button>
      {open && (
        <div className="mt-1">
          <BlockRow tag="equal" lines={lines} side="a" />
        </div>
      )}
    </div>
  );
}

export function DiffViewer({
  draftId,
  fromVersion,
  toVersion,
  persona,
}: {
  draftId: string;
  fromVersion: number;
  toVersion: number;
  persona: PersonaKey;
}) {
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!draftId || !fromVersion || !toVersion) return;
    setBusy(true);
    setError(null);
    try {
      setDiff(await fetchDraftDiff(draftId, fromVersion, toVersion, persona));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDiff(null);
    } finally {
      setBusy(false);
    }
  }, [draftId, fromVersion, toVersion, persona]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!draftId) {
    return (
      <div className="mx-auto max-w-3xl p-6 text-sm text-text-muted">
        Missing <code>?draft=</code> query param.
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6 text-text">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Version diff</h1>
        <span className="rounded bg-surface-sunken px-2 py-0.5 text-xs text-text-muted">
          draft <span className="font-mono">{draftId}</span>
        </span>
        <span className="text-sm text-text-muted">
          v{fromVersion} → v{toVersion}
        </span>
        <Link
          href={`/studio?draft=${encodeURIComponent(draftId)}&persona=${encodeURIComponent(persona)}`}
          className="ml-auto rounded-lg border border-border-strong px-3 py-1 text-xs text-text transition-colors hover:bg-surface-sunken"
        >
          Back to Studio
        </Link>
      </header>

      {busy && <p className="text-sm text-text-muted">Computing diff…</p>}
      {error && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-3 text-sm text-status-rejected-text">
          {error}
        </div>
      )}

      {diff && (
        <>
          <div className="flex flex-wrap gap-2 text-xs text-text-muted">
            <span>a: {diff.a_line_count} lines</span>
            <span>b: {diff.b_line_count} lines</span>
            <span className="text-status-approved-text">+{diff.stats.insert || 0}</span>
            <span className="text-status-rejected-text">-{diff.stats.delete || 0}</span>
            <span className="text-status-changes-text">±{diff.stats.replace || 0}</span>
            <span className="text-text-muted">={diff.stats.equal || 0}</span>
          </div>
          <div className="space-y-3 rounded-lg border border-border bg-surface-raised p-3">
            {diff.blocks.map((b, i) => (
              <div key={i} className="space-y-1">
                {(b.tag === "delete" || b.tag === "replace") && (
                  <BlockRow tag={b.tag} lines={b.a_lines} side="a" />
                )}
                {(b.tag === "insert" || b.tag === "replace") && (
                  <BlockRow tag={b.tag} lines={b.b_lines} side="b" />
                )}
                {b.tag === "equal" && <CollapsibleUnchanged lines={b.a_lines} />}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
