"use client";

/**
 * TECHNICAL SPIKE ONLY — not final CFC UI.
 * Purpose: prove SuperDoc can open/edit/export a real DOCX in Next.js.
 * Product UI lives at /studio and will be redesigned.
 */
import { useRef, useState } from "react";
import Link from "next/link";
import { SuperDocEditor, type SuperDocEditorRef } from "@/components/SuperDocClient";

export default function SuperDocSpikeClient() {
  const ref = useRef<SuperDocEditorRef | null>(null);
  const [ready, setReady] = useState(false);
  const [msg, setMsg] = useState("Opening /fixtures/sample.docx …");

  async function exportDoc(download: boolean) {
    const instance = ref.current?.getInstance?.();
    if (!instance) return;
    const result = await instance.export({
      exportType: ["docx"],
      exportedName: "cfc-superdoc-spike",
      triggerDownload: download,
    });
    if (!download && result instanceof Blob) {
      setMsg(`Exported blob: ${result.size} bytes, type=${result.type}`);
    } else {
      setMsg("Download triggered");
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 p-4 text-zinc-100">
      <div className="mb-3 rounded-lg border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
        Technical SuperDoc spike only — not the final platform UI.{" "}
        <Link href="/studio" className="underline hover:text-amber-100">
          Open Document Studio
        </Link>{" "}
        for the workflow shell (also early).
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-lg font-semibold">SuperDoc spike (fixture)</h1>
        <button
          type="button"
          disabled={!ready}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm disabled:opacity-50"
          onClick={() => void exportDoc(true)}
        >
          Export download
        </button>
        <button
          type="button"
          disabled={!ready}
          className="rounded border border-zinc-600 px-3 py-1.5 text-sm disabled:opacity-50"
          onClick={() => void exportDoc(false)}
        >
          Export blob size
        </button>
      </div>
      <p className="mb-2 text-xs text-zinc-400">{msg}</p>
      <div className="h-[80vh] overflow-hidden rounded-xl border border-zinc-800">
        <SuperDocEditor
          ref={ref}
          document="/fixtures/sample.docx"
          documentMode="editing"
          role="editor"
          user={{ name: "Spike User", email: "spike@cfc.local" }}
          onReady={() => {
            setReady(true);
            setMsg("Editor ready — edit then export");
          }}
          onContentError={({ error }: { error?: unknown }) => setMsg(String(error))}
          onException={({ error }: { error?: unknown }) => setMsg(String(error))}
          style={{ height: "100%" }}
        />
      </div>
    </main>
  );
}
