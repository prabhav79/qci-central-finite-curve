"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type DiffResponse, type PersonaKey, fetchDraftDiff } from "@/lib/cfcApi";

function BlockRow({ tag, lines, side }: { tag: string; lines: string[]; side: "a" | "b" }) {
  if (!lines.length) return null;
  const tone =
    tag === "equal"
      ? "text-zinc-400"
      : tag === "delete" || (tag === "replace" && side === "a")
        ? "bg-red-950/40 text-red-200 border-l-2 border-red-700 pl-2"
        : "bg-emerald-950/40 text-emerald-200 border-l-2 border-emerald-700 pl-2";
  const prefix = tag === "equal" ? "  " : side === "a" ? "- " : "+ ";
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => (
        <div key={i} className={`whitespace-pre-wrap font-mono text-[11px] ${tone}`}>
          <span className="mr-1 select-none text-zinc-600">{prefix}</span>
          {line || " "}
        </div>
      ))}
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
      <div className="mx-auto max-w-3xl p-6 text-sm text-zinc-500">
        Missing <code>?draft=</code> query param.
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Version diff</h1>
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300">
          draft <span className="font-mono">{draftId}</span>
        </span>
        <span className="text-sm text-zinc-400">
          v{fromVersion} → v{toVersion}
        </span>
        <Link
          href={`/studio?draft=${encodeURIComponent(draftId)}&persona=${encodeURIComponent(persona)}`}
          className="ml-auto rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
        >
          Back to Studio
        </Link>
      </header>

      {busy && <p className="text-sm text-zinc-500">Computing diff…</p>}
      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {diff && (
        <>
          <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
            <span>a: {diff.a_line_count} lines</span>
            <span>b: {diff.b_line_count} lines</span>
            <span className="text-emerald-300">+{diff.stats.insert || 0}</span>
            <span className="text-red-300">-{diff.stats.delete || 0}</span>
            <span className="text-amber-300">±{diff.stats.replace || 0}</span>
            <span className="text-zinc-600">={diff.stats.equal || 0}</span>
          </div>
          <div className="space-y-3 rounded border border-zinc-800 bg-zinc-950 p-3">
            {diff.blocks.map((b, i) => (
              <div key={i} className="space-y-1">
                {(b.tag === "delete" || b.tag === "replace") && (
                  <BlockRow tag={b.tag} lines={b.a_lines} side="a" />
                )}
                {(b.tag === "insert" || b.tag === "replace") && (
                  <BlockRow tag={b.tag} lines={b.b_lines} side="b" />
                )}
                {b.tag === "equal" && (
                  <details className="text-[11px]">
                    <summary className="cursor-pointer text-zinc-600">
                      {b.a_lines.length} unchanged line{b.a_lines.length === 1 ? "" : "s"}
                    </summary>
                    <BlockRow tag="equal" lines={b.a_lines} side="a" />
                  </details>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
