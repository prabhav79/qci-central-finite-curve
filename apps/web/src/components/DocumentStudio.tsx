"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SuperDocEditor, type SuperDocEditorRef } from "@/components/SuperDocClient";
import { RagPanel } from "@/components/RagPanel";
import { ThreadsPanel } from "@/components/ThreadsPanel";
import { CorpusUploader } from "@/components/CorpusUploader";
import { AgentPanel } from "@/components/AgentPanel";
import { DecisionModal, type DecisionKind } from "@/components/DecisionModal";
import { NewDraftModal, type GenerationProviderChoice, type TemplateChoice } from "@/components/NewDraftModal";
import { DraftIntakeOverlay } from "@/components/DraftIntakeOverlay";
import { StudioSidebarTabs } from "@/components/StudioSidebarTabs";
import { StatusPill } from "@/components/StatusPill";
import {
  PERSONAS,
  type PersonaKey,
  type Provider,
  type DraftRecord,
  type CorpusHit,
  type DraftSession,
  type CurrentUser,
  apiGet,
  apiJson,
  createDraft,
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
  const searchParams = useSearchParams();
  const openParamHandledRef = useRef<string | null>(null);
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
  // The clarifying-questions Q&A (draft_intake) now runs entirely in its own
  // centered overlay rather than inline inside AgentPanel — this is the
  // overlay's full input state; it's gone once intake completes or the user
  // abandons it, at which point pendingGeneration below takes over.
  const [intakeState, setIntakeState] = useState<{
    draftId: string;
    title: string;
    brief: string;
    providerChoice: GenerationProviderChoice;
  } | null>(null);
  const [pendingGeneration, setPendingGeneration] = useState<{
    preset: string;
    prompt: string;
    provider?: Provider;
    apiKey?: string;
    model?: string;
  } | null>(null);
  // Bumped whenever a generation run auto-starts, to force the sidebar onto
  // the Generate tab — otherwise it runs invisibly behind the (2b) tabs'
  // default "Draft" tab and the user never sees it happen.
  const [focusGenerateSignal, setFocusGenerateSignal] = useState(0);
  // SuperDoc's own theme (Paper/Night/Sepia) — independent of the app's
  // own theme (next-themes), scoped to the editor container via
  // data-superdoc-theme + superdoc-theme-overrides.css.
  const [superdocTheme, setSuperdocTheme] = useState<"light" | "dark" | "sepia">("light");
  useEffect(() => {
    try {
      const stored = localStorage.getItem("cfc-superdoc-theme");
      if (stored === "light" || stored === "dark" || stored === "sepia") setSuperdocTheme(stored);
    } catch {
      // localStorage unavailable (private mode, etc.) — default stands.
    }
  }, []);
  function changeSuperdocTheme(theme: "light" | "dark" | "sepia") {
    setSuperdocTheme(theme);
    try {
      localStorage.setItem("cfc-superdoc-theme", theme);
    } catch {
      // best-effort persistence only
    }
  }
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

  // Lets a knowledge-graph document leaf that resolves to a real Draft open
  // it here, via the same loadDraft flow the manual "Open" button uses.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || openParamHandledRef.current === openId) return;
    openParamHandledRef.current = openId;
    void loadDraft(openId, persona);
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onBeforeUnload = (ev: BeforeUnloadEvent) => {
      if (!dirty) return;
      ev.preventDefault();
      ev.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  async function onCreate(
    title: string,
    brief: string,
    template: TemplateChoice,
    generationProvider: GenerationProviderChoice,
  ) {
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
        // Generate tab is focused immediately so it's already active
        // underneath once DraftIntakeOverlay's Q&A finishes and hands off
        // to draft_generator via onIntakeComplete below.
        setFocusGenerateSignal((n) => n + 1);
        setIntakeState({
          draftId: res.draft.id,
          title,
          brief: brief.trim(),
          providerChoice: generationProvider,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
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
    <div className="flex h-[calc(100vh-2rem)] flex-col gap-3 p-4 text-text">
      <header className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-raised p-3">
        <div className="mr-auto min-w-[160px]">
          <p className="text-[11px] text-text-muted">{health}</p>
        </div>
        {me && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-2 py-1 text-xs text-text-muted">
            <span>
              Signed in as <span className="font-medium text-text">{me.name}</span>
              {me.designation ? ` · ${me.designation}` : ""}
            </span>
            <button
              type="button"
              onClick={() => void logout().then(() => router.push("/login"))}
              className="rounded border border-border-strong px-2 py-0.5 transition-colors hover:bg-surface-raised hover:text-text"
            >
              Sign out
            </button>
          </div>
        )}
        {me?.auth_mode === "personas" && (
        <label className="text-xs text-text-muted">
          Persona (dev)
          <select
            className="ml-2 rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text"
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
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => setNewDraftOpen(true)}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          New draft
        </button>
        <button
          type="button"
          disabled={busy || !session?.can_save || !ready}
          onClick={() => void onSave()}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          Save DOCX
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void onExportDownload()}
          className="rounded-lg border border-border-strong px-3 py-1.5 text-sm text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
        >
          Download
        </button>
        <button
          type="button"
          disabled={busy || !session?.can_submit}
          onClick={() => void onSubmit()}
          className="rounded-lg bg-action-changes px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-action-changes-hover disabled:opacity-50"
        >
          Submit L1
        </button>
        {session?.can_decide_l1 && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-sunken p-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onApprove(1)}
              className="rounded-md bg-action-approve px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-action-approve-hover disabled:opacity-50"
              title="L1 Approve → sends to L2"
            >
              L1 Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 1, kind: "changes_requested" })}
              className="rounded-md px-2 py-1 text-xs text-action-changes transition-colors hover:bg-surface-raised disabled:opacity-50"
              title="Send back to maker with a written reason"
            >
              Changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 1, kind: "reject" })}
              className="rounded-md px-2 py-1 text-xs text-action-reject transition-colors hover:bg-surface-raised disabled:opacity-50"
              title="Reject the draft with a written reason"
            >
              Reject
            </button>
          </div>
        )}
        {session?.can_decide_l2 && (
          <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-sunken p-0.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onApprove(2)}
              className="rounded-md bg-action-approve px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-action-approve-hover disabled:opacity-50"
              title="L2 Final → seals FINAL_APPROVED"
            >
              L2 Final
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 2, kind: "changes_requested" })}
              className="rounded-md px-2 py-1 text-xs text-action-changes transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              Changes
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDecisionDialog({ level: 2, kind: "reject" })}
              className="rounded-md px-2 py-1 text-xs text-action-reject transition-colors hover:bg-surface-raised disabled:opacity-50"
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
        onConfirm={(title, brief, template, generationProvider) => onCreate(title, brief, template, generationProvider)}
      />

      {intakeState && (
        <DraftIntakeOverlay
          key={intakeState.draftId}
          open={true}
          draftId={intakeState.draftId}
          title={intakeState.title}
          brief={intakeState.brief}
          providerChoice={intakeState.providerChoice}
          persona={persona}
          onComplete={(enrichedBrief) => {
            const { providerChoice } = intakeState;
            setIntakeState(null);
            setPendingGeneration({
              preset: "draft_generator",
              prompt: enrichedBrief,
              provider: providerChoice.provider,
              apiKey: providerChoice.apiKey,
              model: providerChoice.model,
            });
          }}
          onAbandon={() => setIntakeState(null)}
        />
      )}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_340px]">
        <section className="min-h-0 overflow-auto rounded-xl border border-border bg-surface-raised">
          {file ? (
            // SuperDoc's own CSS defines no overflow/scroll rules at all — it expects
            // the host app to be the scroll container (confirmed: none of its internal
            // wrapper classes set overflow-y). The 816px-wide page also isn't
            // self-centering, so we center it here. Trade-off: the toolbar scrolls
            // with the document rather than staying sticky — SuperDoc's DOM structure
            // isn't guaranteed stable enough across versions to safely carve the
            // toolbar out on its own; revisit as part of the design pass if a pinned
            // toolbar turns out to matter.
            <div data-superdoc-theme={superdocTheme}>
              <div className="flex items-center justify-end gap-1 border-b border-border bg-surface-sunken px-2 py-1">
                <span className="mr-auto text-[10px] uppercase tracking-wide text-text-muted">
                  Document theme
                </span>
                {(["light", "dark", "sepia"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => changeSuperdocTheme(t)}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                      superdocTheme === t
                        ? "bg-accent text-white"
                        : "bg-surface-raised text-text-muted hover:text-text"
                    }`}
                  >
                    {t === "light" ? "Paper" : t === "dark" ? "Night" : "Sepia"}
                  </button>
                ))}
              </div>
              <div
                className="flex h-[calc(100vh-13rem)] justify-center overflow-auto"
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
            </div>
          ) : (
            <div className="flex h-[480px] flex-col items-center justify-center gap-2 text-sm text-text-muted">
              <p>No document loaded.</p>
              <p className="text-xs">New draft · or open a draft id</p>
            </div>
          )}
        </section>

        <aside className="space-y-3 overflow-auto rounded-xl border border-border bg-surface-raised p-3 text-sm">
          {/* Status/error reflect document-level actions (Save, Submit,
           * decisions) — kept always visible regardless of which tab is
           * active, rather than buried inside one panel. */}
          <div className="rounded-lg border border-border bg-surface-sunken p-2 text-xs text-text-muted">
            {statusMsg}
          </div>
          {error && (
            <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-xs text-status-rejected-text">
              {error}
            </div>
          )}

          <StudioSidebarTabs
            activateGenerateSignal={focusGenerateSignal}
            draft={
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    value={openIdInput}
                    onChange={(e) => setOpenIdInput(e.target.value)}
                    placeholder="draft id"
                    className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 font-mono text-xs text-text outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    disabled={busy || !openIdInput.trim()}
                    onClick={() => void onOpenId()}
                    className="rounded-lg border border-border-strong px-2 py-1 text-xs text-text transition-colors hover:bg-surface-sunken disabled:opacity-50"
                  >
                    Open
                  </button>
                </div>

                {draftId && (
                  <div className="rounded-lg border border-border bg-surface-sunken p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-text">
                        {draftMeta?.title || "Untitled draft"}
                      </span>
                      {session?.status && <StatusPill status={session.status} />}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
                      <span className="font-mono">{draftId}</span>
                      {versions && versions.length > 0 && (
                        <span>
                          · {versions.length} revision{versions.length === 1 ? "" : "s"}
                        </span>
                      )}
                      {dirty && (
                        <span className="rounded-full bg-status-pending-l1-surface px-1.5 py-0.5 text-[10px] font-medium text-status-pending-l1-text">
                          Unsaved changes
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div>
                  <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-text-muted">
                    <span>Versions</span>
                    {draftId && versions && versions.length >= 2 && (
                      <a
                        href={`/studio/diff?draft=${encodeURIComponent(draftId)}&from=${
                          versions[versions.length - 2].version
                        }&to=${versions[versions.length - 1].version}&persona=${persona}`}
                        className="text-[10px] normal-case tracking-normal text-accent hover:underline"
                      >
                        diff last 2
                      </a>
                    )}
                  </div>
                  <ul className="max-h-28 space-y-1 overflow-auto text-[11px] text-text-muted">
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
                              className="ml-auto text-[9px] text-accent hover:underline"
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
                  <div className="mb-1 text-xs uppercase tracking-wide text-text-muted">Recent drafts</div>
                  <ul className="max-h-40 space-y-1 overflow-auto text-[11px]">
                    {recent.length === 0 && (
                      <li className="text-text-muted">None yet — create a draft</li>
                    )}
                    {recent.map((item) => (
                      <li key={item.draft.id}>
                        <button
                          type="button"
                          className="w-full rounded px-1 py-0.5 text-left transition-colors hover:bg-surface-sunken"
                          onClick={() => void loadDraft(item.draft.id, persona)}
                        >
                          <span className="font-mono text-text">{item.draft.id}</span>
                          <span className="block truncate text-text-muted">
                            {item.draft.status} · {item.draft.title}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            }
            generate={
              <AgentPanel
                draftId={draftId}
                persona={persona}
                superdocRole={session?.superdoc_role}
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
            }
            research={
              <RagPanel persona={persona} canInsert={Boolean(session?.can_save && ready)} onInsertCitation={insertCitationIntoDraft} />
            }
            corpus={
              <CorpusUploader
                persona={persona}
                isAdmin={session?.user.cfc_role === "admin" || persona === "admin"}
              />
            }
            comments={
              <ThreadsPanel
                draftId={draftId}
                persona={persona}
                canComment={Boolean(session && session.superdoc_role !== "viewer")}
                refreshKey={threadsRefreshKey}
              />
            }
          />
        </aside>
      </div>
    </div>
  );
}