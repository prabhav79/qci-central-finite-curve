"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SuperDocEditor, type SuperDocEditorRef } from "@/components/SuperDocClient";
import { RagPanel } from "@/components/RagPanel";
import { ThreadsPanel } from "@/components/ThreadsPanel";
import { CorpusUploader } from "@/components/CorpusUploader";
import { AgentPanel } from "@/components/AgentPanel";
import { DecisionModal, type DecisionKind } from "@/components/DecisionModal";
import { NewDraftModal, type TemplateChoice } from "@/components/NewDraftModal";
import {
  PERSONAS,
  type PersonaKey,
  type DraftRecord,
  type CorpusHit,
  type DraftSession,
  type CurrentUser,
  apiGet,
  apiJson,
  createDraft,
  createDraftFromWorker,
  decideDraft,
  fetchDraftFile,
  getCurrentUser,
  integrationsHealth,
  listDrafts,
  listVersions,
  logout,
  saveDraftFile,
  syncThreads,
} from "@/lib/cfcApi";
import { extractSuperDocThreads } from "@/lib/superdocThreads";

export function DocumentStudio({
  initialDraftId,
  initialPersona,
}: {
  initialDraftId?: string;
  initialPersona?: PersonaKey;
}) {
  const router = useRouter();
  const editorRef = useRef<SuperDocEditorRef | null>(null);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [persona, setPersona] = useState<PersonaKey>(initialPersona ?? "arpit");
  const [draftId, setDraftId] = useState<string | undefined>(initialDraftId);
  const [openIdInput, setOpenIdInput] = useState("");
  const [session, setSession] = useState<DraftSession | null>(null);
  const [draftMeta, setDraftMeta] = useState<DraftRecord | null>(null);
  const [versions, setVersions] = useState<NonNullable<DraftRecord["versions"]>>([]);
  const [recent, setRecent] = useState<Array<{ draft: DraftRecord; session: DraftSession }>>([]);
  const [file, setFile] = useState<File | null>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<string>("checking services…");
  const [statusMsg, setStatusMsg] = useState("Select persona and create or open a draft.");
  const [error, setError] = useState<string | null>(null);
  const [threadsRefreshKey, setThreadsRefreshKey] = useState(0);
  const [decisionDialog, setDecisionDialog] = useState<
    | { level: 1 | 2; kind: DecisionKind }
    | null
  >(null);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const [pendingGeneration, setPendingGeneration] = useState<{ preset: string; prompt: string } | null>(null);
  const fileRev = useMemo(
    () => (file ? `${file.name}-${file.size}-${file.lastModified}` : "none"),
    [file],
  );

  const refreshRecent = useCallback(
    async (p: PersonaKey = persona) => {
      try {
        const res = await listDrafts(p);
        setRecent(res.items.slice(0, 8));
      } catch {
        // API may be down; ignore list errors in sidebar
      }
    },
    [persona],
  );

  const refreshHealth = useCallback(async () => {
    try {
      const h = await integrationsHealth();
      const w = h.doc_worker?.ok
        ? "doc-worker ok"
        : `doc-worker down (${h.doc_worker?.error || "unreachable"})`;
      setHealth(`API ok · template ${h.template_exists ? "ok" : "missing"} · ${w}`);
    } catch (e) {
      setHealth(`API down: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const loadDraft = useCallback(
    async (id: string, p: PersonaKey = persona) => {
      setBusy(true);
      setError(null);
      setReady(false);
      try {
        const pack = await listVersions(id, p);
        const full = await apiGet<{ draft: DraftRecord; session: DraftSession }>(
          `/drafts/${id}`,
          p,
        );
        const docFile = await fetchDraftFile(id);
        setDraftId(id);
        setOpenIdInput(id);
        setSession(full.session);
        setDraftMeta(full.draft);
        setVersions(pack.versions || full.draft.versions || []);
        setFile(docFile);
        setDirty(false);
        setStatusMsg(
          `Loaded v${full.session.version} as ${full.session.user.name} (${full.session.document_mode})`,
        );
        await refreshRecent(p);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [persona, refreshRecent],
  );

  useEffect(() => {
    let cancelled = false;
    getCurrentUser().then((u) => {
      if (cancelled) return;
      if (!u) {
        router.push("/login");
        return;
      }
      setMe(u);
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    void refreshHealth();
    void refreshRecent(persona);
  }, [refreshHealth, refreshRecent, persona]);

  useEffect(() => {
    if (initialDraftId) void loadDraft(initialDraftId, persona);
  }, [initialDraftId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      if (!dirty) return;
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function onCreate(title: string, brief: string, template: TemplateChoice) {
    setBusy(true);
    setError(null);
    try {
      const res = await createDraft(
        persona,
        title,
        template.source === "catalog" ? template.templateCode : "BLANK",
        template.source === "corpus_doc"
          ? { templateSource: "corpus_doc", corpusDocId: template.corpusDocId }
          : { templateSource: "catalog" },
      );
      setNewDraftOpen(false);
      await loadDraft(res.draft.id, persona);
      if (brief.trim()) {
        setPendingGeneration({ preset: "draft_generator", prompt: brief.trim() });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function onCreateFromWorker() {
    setBusy(true);
    setError(null);
    setStatusMsg("Seeding DOCX via doc-worker (SuperDoc SDK)…");
    try {
      const res = await createDraftFromWorker(persona, {
        title: "CPGRAMS PMU Extension — Worker Seeded",
        replace: "Quality Council of India (CFC Generated Draft)",
      });
      const note = res.worker?.replaced
        ? "worker replaced text"
        : res.worker?.fallback
          ? `worker fallback: ${String(res.worker?.warning || "")}`
          : "worker seed complete";
      setStatusMsg(`Worker draft created (${note})`);
      await loadDraft(res.draft.id, persona);
      await refreshHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function onOpenId() {
    const id = openIdInput.trim();
    if (!id) return;
    await loadDraft(id, persona);
  }

  async function onSave() {
    if (!draftId || !session?.can_save) return;
    const instance = editorRef.current?.getInstance?.();
    if (!instance) {
      setError("Editor not ready");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const exported = await instance.export({
        exportType: ["docx"],
        triggerDownload: false,
      });
      const blob = exported instanceof Blob ? exported : (exported as Blob);
      if (!(blob instanceof Blob) || blob.size < 100) {
        throw new Error("Export did not return a valid DOCX blob");
      }
      const result = await saveDraftFile(draftId, persona, blob, "manual");
      setDirty(false);
      setSession(result.session);
      // Best-effort mirror SuperDoc comments/tracked-changes to CFC threads table.
      try {
        const extracted = extractSuperDocThreads(instance);
        if (extracted.length) {
          await syncThreads(draftId, persona, extracted);
        }
      } catch {
        // Non-fatal — SuperDoc comment API varies across versions.
      }
      setStatusMsg(`Saved v${result.version} (${blob.size} bytes)`);
      const pack = await listVersions(draftId, persona);
      setVersions(pack.versions || []);
      // Keep editor open without forced reload unless you prefer strict disk sync:
      // reload ensures durable bytes, but remounts SuperDoc (slower).
      const docFile = await fetchDraftFile(draftId);
      setFile(docFile);
      setReady(false);
      await refreshRecent(persona);
      setThreadsRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onExportDownload() {
    const instance = editorRef.current?.getInstance?.();
    if (!instance) return;
    await instance.export({
      exportType: ["docx"],
      exportedName: draftId || "cfc-draft",
      triggerDownload: true,
    });
  }

  async function onSubmit() {
    if (!draftId) return;
    setBusy(true);
    try {
      if (session?.can_save && dirty) await onSave();
      const res = await apiJson<{ session: DraftSession }>(
        `/drafts/${draftId}/submit`,
        persona,
        { method: "POST", body: "{}" },
      );
      setSession(res.session);
      setStatusMsg(`Submitted -> ${res.session.status}`);
      await loadDraft(draftId, persona);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function onApprove(level: 1 | 2) {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    try {
      if (session?.can_save && dirty) await onSave();
      const res = await decideDraft(draftId, persona, {
        level,
        decision: "approve",
        comments: `L${level} approved via CFC Studio`,
      });
      setSession(res.session);
      setStatusMsg(`Decision L${level}: approve -> ${res.session.status}`);
      await loadDraft(draftId, persona);
      setThreadsRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function onDecideWithComment(
    level: 1 | 2,
    decision: DecisionKind,
    comment: string,
  ) {
    if (!draftId) return;
    setBusy(true);
    setError(null);
    try {
      if (session?.can_save && dirty) await onSave();
      const res = await decideDraft(draftId, persona, {
        level,
        decision,
        comments: comment,
      });
      setSession(res.session);
      setStatusMsg(`Decision L${level}: ${decision} -> ${res.session.status}`);
      setDecisionDialog(null);
      await loadDraft(draftId, persona);
      setThreadsRefreshKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function onPersonaChange(next: PersonaKey) {
    setPersona(next);
    if (draftId) await loadDraft(draftId, next);
    else await refreshRecent(next);
  }


  async function insertCitationIntoDraft(hit: CorpusHit) {
    type SuperDocLike = {
      activeEditor?: {
        commands?: { focus: (pos: string) => void; insertContent: (html: string) => void };
        doc?: { insert?: (args: unknown) => Promise<void> | void };
      };
      doc?: { insert?: (args: unknown) => Promise<void> | void };
    };
    const instance = editorRef.current?.getInstance?.() as SuperDocLike | null | undefined;
    if (!instance) throw new Error("Open/edit a draft first (editor not ready)");
    if (!session?.can_save) throw new Error("Current persona cannot edit this draft");
    const block = `\n\n[CFC Citation]\nSource: ${hit.title}\nMinistry: ${hit.ministry}\nDoc: ${hit.doc_id}\nPath: ${hit.source}\n---\n${(hit.text || "").slice(0, 1200)}\n[/CFC Citation]\n`;
    const tried: string[] = [];
    const attempts: Array<() => Promise<void>> = [
      async () => {
        if (!instance.activeEditor?.commands?.insertContent) throw new Error("no tiptap insert");
        instance.activeEditor.commands.focus("end");
        instance.activeEditor.commands.insertContent(block.replace(/\n/g, "<br/>"));
      },
      async () => {
        const doc = instance.doc || instance.activeEditor?.doc;
        if (!doc?.insert) throw new Error("no doc.insert");
        await doc.insert({ target: { type: "end" }, content: block });
      },
      async () => {
        if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
        await navigator.clipboard.writeText(block);
        throw new Error("CLIPBOARD_ONLY");
      },
    ];
    for (const fn of attempts) {
      try {
        await fn();
        setDirty(true);
        setStatusMsg(`Citation inserted from ${hit.title}`);
        return;
      } catch (e) {
        tried.push(e instanceof Error ? e.message : String(e));
        if (e instanceof Error && e.message === "CLIPBOARD_ONLY") {
          setStatusMsg("Citation copied to clipboard ? paste into the draft (Ctrl+V)");
          return;
        }
      }
    }
    throw new Error(`Could not insert citation (${tried.join("; ")})`);
  }

  return (
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-3 p-4 text-zinc-100">
      <header className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 p-3">
        <div className="mr-auto min-w-[220px]">
          <h1 className="text-lg font-semibold tracking-tight">CFC Document Studio</h1>
          <p className="text-xs text-zinc-400">
            Early shell · SuperDoc editor · RBAC personas · versioned DOCX
          </p>
          <p className="mt-1 text-[11px] text-zinc-500">{health}</p>
        </div>
        {me && (
          <div className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
            <span>
              Signed in as <span className="font-medium text-zinc-100">{me.name}</span>
              {me.designation ? ` · ${me.designation}` : ""}
            </span>
            <button
              type="button"
              onClick={() => void logout().then(() => router.push("/login"))}
              className="rounded border border-zinc-600 px-2 py-0.5 hover:bg-zinc-800"
            >
              Sign out
            </button>
          </div>
        )}
        <label className="text-xs text-zinc-400">
          Persona (dev)
          <select
            className="ml-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            value={persona}
            onChange={(e) => void onPersonaChange(e.target.value as PersonaKey)}
          >
            {Object.entries(PERSONAS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => setNewDraftOpen(true)}
          className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
        >
          New draft
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onCreateFromWorker()}
          className="rounded bg-teal-700 px-3 py-1.5 text-sm font-medium hover:bg-teal-600 disabled:opacity-50"
          title="Requires npm run dev:doc-worker"
        >
          Generate via worker
        </button>
        <button
          type="button"
          disabled={busy || !session?.can_save || !ready}
          onClick={() => void onSave()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
        >
          Save DOCX
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void onExportDownload()}
          className="rounded border border-zinc-600 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
        >
          Download
        </button>
        <button
          type="button"
          disabled={busy || !session?.can_submit}
          onClick={() => void onSubmit()}
          className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium hover:bg-amber-500 disabled:opacity-50"
        >
          Submit L1
        </button>
        {session?.can_decide_l1 && (
          <div className="flex items-center gap-1 rounded border border-violet-800 bg-violet-950/40 p-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onApprove(1)}
              className="rounded bg-violet-600 px-2.5 py-1 text-xs font-medium hover:bg-violet-500 disabled:opacity-50"
              title="L1 Approve → sends to L2"
            >
              L1 Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 1, kind: "changes_requested" })}
              className="rounded px-2 py-1 text-xs text-violet-200 hover:bg-violet-900/50 disabled:opacity-50"
              title="Send back to maker with a written reason"
            >
              Changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 1, kind: "reject" })}
              className="rounded px-2 py-1 text-xs text-red-300 hover:bg-red-900/50 disabled:opacity-50"
              title="Reject the draft with a written reason"
            >
              Reject
            </button>
          </div>
        )}
        {session?.can_decide_l2 && (
          <div className="flex items-center gap-1 rounded border border-fuchsia-800 bg-fuchsia-950/40 p-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onApprove(2)}
              className="rounded bg-fuchsia-700 px-2.5 py-1 text-xs font-medium hover:bg-fuchsia-600 disabled:opacity-50"
              title="L2 Final → seals FINAL_APPROVED"
            >
              L2 Final
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 2, kind: "changes_requested" })}
              className="rounded px-2 py-1 text-xs text-fuchsia-200 hover:bg-fuchsia-900/50 disabled:opacity-50"
            >
              Changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 2, kind: "reject" })}
              className="rounded px-2 py-1 text-xs text-red-300 hover:bg-red-900/50 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        )}
      </header>

      <DecisionModal
        open={decisionDialog !== null}
        level={decisionDialog?.level ?? 1}
        kind={decisionDialog?.kind ?? "reject"}
        busy={busy}
        onCancel={() => setDecisionDialog(null)}
        onConfirm={async (comment) => {
          if (!decisionDialog) return;
          await onDecideWithComment(decisionDialog.level, decisionDialog.kind, comment);
        }}
      />

      <NewDraftModal
        open={newDraftOpen}
        persona={persona}
        busy={busy}
        onCancel={() => setNewDraftOpen(false)}
        onConfirm={(title, brief, template) => onCreate(title, brief, template)}
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_340px]">
        <section className="min-h-0 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950">
          {file ? (
            // SuperDoc's own CSS defines no overflow/scroll rules at all — it expects
            // the host app to be the scroll container (confirmed: none of its internal
            // wrapper classes set overflow-y). The 816px-wide page also isn't
            // self-centering, so we center it here. Trade-off: the toolbar scrolls
            // with the document rather than staying sticky — SuperDoc's DOM structure
            // isn't guaranteed stable enough across versions to safely carve the
            // toolbar out on its own; revisit as part of the design pass if a pinned
            // toolbar turns out to matter.
            <div
              className="flex h-[calc(100vh-11rem)] justify-center overflow-auto"
              key={fileRev}
            >
              <SuperDocEditor
                ref={editorRef}
                document={file}
                documentMode={session?.document_mode ?? "viewing"}
                role={session?.superdoc_role ?? "viewer"}
                user={
                  session
                    ? {
                        name: session.user.name,
                        email: session.user.email,
                      }
                    : { name: "CFC User", email: "user@cfc.local" }
                }
                onReady={() => {
                  setReady(true);
                  setStatusMsg((s) => `${s} · editor ready`);
                }}
                onEditorUpdate={() => setDirty(true)}
                onContentError={({ error }: { error?: unknown }) =>
                  setError(error instanceof Error ? error.message : String(error))
                }
                onException={({ error }: { error?: unknown }) =>
                  setError(error instanceof Error ? error.message : String(error))
                }
                style={{ height: "100%", minHeight: 480 }}
              />
            </div>
          ) : (
            <div className="flex h-[480px] flex-col items-center justify-center gap-2 text-sm text-zinc-500">
              <p>No document loaded.</p>
              <p className="text-xs">New draft · Generate via worker · or open a draft id</p>
            </div>
          )}
        </section>

        <aside className="space-y-3 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-sm">
          <div className="flex gap-2">
            <input
              value={openIdInput}
              onChange={(e) => setOpenIdInput(e.target.value)}
              placeholder="draft id"
              className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs"
            />
            <button
              type="button"
              disabled={busy || !openIdInput.trim()}
              onClick={() => void onOpenId()}
              className="rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
            >
              Open
            </button>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Workflow</div>
            <dl className="mt-2 space-y-1 text-zinc-300">
              <div className="flex justify-between gap-2">
                <dt>Draft</dt>
                <dd className="font-mono text-xs">{draftId ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Title</dt>
                <dd className="truncate text-xs">{draftMeta?.title ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Status</dt>
                <dd>{session?.status ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Version</dt>
                <dd>{session?.version ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Mode</dt>
                <dd>
                  {session?.document_mode ?? "—"} / {session?.superdoc_role ?? "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Dirty</dt>
                <dd>{dirty ? "unsaved" : "clean"}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Editor</dt>
                <dd>{ready ? "ready" : file ? "loading" : "idle"}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-400">
            {statusMsg}
          </div>
          {error && (
            <div className="rounded border border-red-900 bg-red-950/50 p-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div>
            <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
              <span>Versions</span>
              {draftId && versions && versions.length >= 2 && (
                <a
                  href={`/studio/diff?draft=${encodeURIComponent(draftId)}&from=${
                    versions[versions.length - 2].version
                  }&to=${versions[versions.length - 1].version}&persona=${persona}`}
                  className="text-[10px] normal-case tracking-normal text-blue-400 hover:underline"
                >
                  diff last 2
                </a>
              )}
            </div>
            <ul className="max-h-28 space-y-1 overflow-auto text-[11px] text-zinc-400">
              {(versions || []).length === 0 && <li>No versions yet</li>}
              {[...(versions || [])].reverse().map((v, i, arr) => {
                const prev = arr[i + 1];
                return (
                  <li key={v.version} className="flex items-center gap-1 font-mono">
                    <span>
                      v{v.version} · {v.trigger} · {v.created_at?.slice(0, 19)}
                    </span>
                    {prev && draftId && (
                      <a
                        href={`/studio/diff?draft=${encodeURIComponent(draftId)}&from=${prev.version}&to=${v.version}&persona=${persona}`}
                        className="ml-auto text-[9px] text-blue-400 hover:underline"
                        title={`diff v${prev.version} → v${v.version}`}
                      >
                        diff
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">Recent drafts</div>
            <ul className="max-h-40 space-y-1 overflow-auto text-[11px]">
              {recent.length === 0 && (
                <li className="text-zinc-500">None yet — create a draft</li>
              )}
              {recent.map((item) => (
                <li key={item.draft.id}>
                  <button
                    type="button"
                    className="w-full rounded px-1 py-0.5 text-left hover:bg-zinc-900"
                    onClick={() => void loadDraft(item.draft.id, persona)}
                  >
                    <span className="font-mono text-zinc-300">{item.draft.id}</span>
                    <span className="block truncate text-zinc-500">
                      {item.draft.status} · {item.draft.title}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <RagPanel persona={persona} canInsert={Boolean(session?.can_save && ready)} onInsertCitation={insertCitationIntoDraft} />

          <AgentPanel
            draftId={draftId}
            persona={persona}
            canRunAgent={Boolean(session?.can_run_agent_mutate)}
            onDraftUpdated={async () => {
              if (!draftId) return;
              await loadDraft(draftId, persona);
              setThreadsRefreshKey((k) => k + 1);
            }}
            onThreadsChanged={() => setThreadsRefreshKey((k) => k + 1)}
            autoRun={pendingGeneration}
            onAutoRunConsumed={() => setPendingGeneration(null)}
          />

          <CorpusUploader
            persona={persona}
            isAdmin={session?.user.cfc_role === "admin" || persona === "admin"}
          />

          <ThreadsPanel
            draftId={draftId}
            persona={persona}
            canComment={Boolean(session && session.superdoc_role !== "viewer")}
            refreshKey={threadsRefreshKey}
          />

          <div className="text-[11px] text-zinc-500">
            Demo path: Arpit generates → edit/save → Submit L1 → switch Aashna → L1
            Approve → Subroto → L2 Final.
            <br />
            Worker button needs <code className="text-zinc-400">npm run dev:doc-worker</code>.
          </div>
        </aside>
      </div>
    </div>
  );
}