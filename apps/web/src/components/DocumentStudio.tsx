"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DocumentSkeleton, SuperDocEditor, type SuperDocEditorRef } from "@/components/SuperDocClient";
import { RagPanel } from "@/components/RagPanel";
import { ThreadsPanel } from "@/components/ThreadsPanel";
import { CorpusUploader } from "@/components/CorpusUploader";
import { AgentPanel, type AgentAutoRun } from "@/components/AgentPanel";
import { DecisionModal, type DecisionKind } from "@/components/DecisionModal";
import { NewDraftModal, type TemplateChoice } from "@/components/NewDraftModal";
import { DraftIntakeOverlay } from "@/components/DraftIntakeOverlay";
import { StudioSidebarTabs } from "@/components/StudioSidebarTabs";
import { StudioHome } from "@/components/StudioHome";
import { StatusPill } from "@/components/StatusPill";
import {
  ApiError,
  PERSONAS,
  type PersonaKey,
  type DraftRecord,
  type CorpusHit,
  type DraftSession,
  type InboxItem,
  type ReaderHighlight,
  addExcerptToDraft,
  apiGet,
  apiJson,
  createDraft,
  decideDraft,
  errorText,
  fetchApprovalsInbox,
  fetchDraftFile,
  integrationsHealth,
  isPersonasMode,
  listDrafts,
  listHighlights,
  listVersions,
  logout,
  saveDraftFile,
  syncThreads,
} from "@/lib/cfcApi";
import { extractSuperDocThreads } from "@/lib/superdocThreads";
import { type LlmChoice, defaultLlmChoice } from "@/lib/llmChoice";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { documentTitle, isEmptyUntitled, versionLabel } from "@/lib/copy";

// "0" restores the old behaviour: every update remounts the editor.
const REPLACE_IN_PLACE = process.env.NEXT_PUBLIC_SUPERDOC_REPLACE !== "0";

const EDITOR_ZOOM = { mode: "fit-width", fitWidth: { min: 60, max: 100, padding: 32 } };
const EDITOR_UI = {
  comments: { layout: "auto" },
  toolbar: {
    excludeItems: ["document-mode", "ai", "formatting-marks", "copy-format", "measurement-unit"],
    responsiveTo: "container",
  },
};
const EDITOR_FONT = 'var(--font-public-sans), "Public Sans", system-ui, sans-serif';

const MODE_TEXT: Record<string, string> = {
  editing: "You can edit",
  suggesting: "Suggesting changes",
  viewing: "View only",
};

type DraftItem = { draft: DraftRecord; session: DraftSession };
type ScrollSnapshot = { top: number; nearBottom: boolean };

/** SuperDoc's contained mode scrolls inside its own DOM; find that element. */
function findScroller(host: HTMLElement | null): HTMLElement | null {
  if (!host) return null;
  const candidates = host.querySelectorAll<HTMLElement>("div");
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (el.scrollHeight - el.clientHeight > 4) {
      const oy = window.getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return el;
    }
  }
  return null;
}

function snapshotScroll(host: HTMLElement | null): ScrollSnapshot {
  const el = findScroller(host);
  if (!el) return { top: 0, nearBottom: true };
  return { top: el.scrollTop, nearBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 160 };
}

/** Layout settles over a few frames after a replace, so apply more than once.
 * While generating, a reader who was at the end keeps following the end. */
function restoreScroll(host: HTMLElement | null, snap: ScrollSnapshot, followEnd: boolean) {
  const apply = () => {
    const el = findScroller(host);
    if (!el) return;
    el.scrollTop = followEnd && snap.nearBottom ? el.scrollHeight : snap.top;
  };
  requestAnimationFrame(apply);
  window.setTimeout(apply, 200);
  window.setTimeout(apply, 600);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function excerpt(text: string, max = 600): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return `${stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(" "))} …`;
}

function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "QCI document";
}

const actionBtn =
  "whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50";

export function DocumentStudio({
  initialDraftId,
  initialPersona,
}: {
  initialDraftId?: string;
  initialPersona?: PersonaKey;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { me, error: meError } = useCurrentUser();
  const openParamHandledRef = useRef<string | null>(null);
  const editorRef = useRef<SuperDocEditorRef | null>(null);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const [persona, setPersona] = useState<PersonaKey>(initialPersona ?? "arpit");
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [session, setSession] = useState<DraftSession | null>(null);
  const [draftMeta, setDraftMeta] = useState<DraftRecord | null>(null);
  const [versions, setVersions] = useState<NonNullable<DraftRecord["versions"]>>([]);
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [servicesDown, setServicesDown] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threadsRefreshKey, setThreadsRefreshKey] = useState(0);
  const [decisionDialog, setDecisionDialog] = useState<{ level: 1 | 2; kind: DecisionKind } | null>(null);
  const [newDraftOpen, setNewDraftOpen] = useState(false);
  const [references, setReferences] = useState<ReaderHighlight[]>([]);
  // The intake Q&A runs in its own overlay; once it finishes (or is
  // skipped), pendingGeneration hands the enriched brief to AgentPanel.
  const [intakeState, setIntakeState] = useState<{
    draftId: string;
    title: string;
    brief: string;
    choice: LlmChoice;
  } | null>(null);
  const [pendingGeneration, setPendingGeneration] = useState<AgentAutoRun | null>(null);
  // Bumped when a generation run auto-starts so the sidebar shows Generate.
  const [focusGenerateSignal, setFocusGenerateSignal] = useState(0);
  const [llmChoice, setLlmChoice] = useState<LlmChoice>({ provider: "anthropic", apiKey: "", model: "" });
  const choiceInitRef = useRef(false);

  const readyRef = useRef(false);
  const replacingRef = useRef(0);
  const sessionRef = useRef<DraftSession | null>(null);
  const draftIdRef = useRef<string | undefined>(undefined);
  const loadSeqRef = useRef(0);
  const generatingRef = useRef(false);
  const generationEndedAtRef = useRef(0);
  const replaceChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestFileRef = useRef<File | null>(null);
  const pendingScrollRef = useRef<ScrollSnapshot | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const personasMode = isPersonasMode(me);
  const isAdmin = me ? (personasMode ? persona === "admin" || Boolean(me.is_admin) : Boolean(me.is_admin)) : false;
  const locked = busy || generating;

  useEffect(() => {
    if (me && !choiceInitRef.current) {
      choiceInitRef.current = true;
      setLlmChoice(defaultLlmChoice(me));
    }
  }, [me]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  const refreshLists = useCallback(
    async (p: PersonaKey = persona) => {
      const [list, waiting] = await Promise.allSettled([listDrafts(p), fetchApprovalsInbox(p)]);
      if (list.status === "fulfilled") setDrafts(list.value.items);
      if (waiting.status === "fulfilled") setInbox(waiting.value.items);
      setDraftsLoading(false);
    },
    [persona],
  );

  const refreshHealth = useCallback(async () => {
    try {
      const h = await integrationsHealth();
      setServicesDown(!h.doc_worker?.ok);
    } catch (e) {
      setServicesDown(!(e instanceof ApiError) || e.status === 0 || e.status >= 500);
    }
  }, []);

  // The last update of a run lands just after streaming stops; it should
  // still follow the end of the document like the ones before it.
  const followingGeneration = useCallback(
    () => generatingRef.current || Date.now() - generationEndedAtRef.current < 5000,
    [],
  );

  const mountFile = useCallback((file: File) => {
    readyRef.current = false;
    setReady(false);
    setDirty(false);
    setDocFile(file);
  }, []);

  // Swaps the open document's contents without remounting the editor, so the
  // toolbar, zoom and scroll position survive. Falls back to a remount.
  const replaceInPlace = useCallback(
    (file: File) => {
      const run = async () => {
        if (latestFileRef.current !== file) return;
        const instance = editorRef.current?.getInstance();
        if (!instance?.replaceDocument || !readyRef.current) {
          mountFile(file);
          return;
        }
        const snap = snapshotScroll(editorHostRef.current);
        replacingRef.current += 1;
        try {
          const result = await instance.replaceDocument(file);
          if (!result?.ok) throw new Error(result?.reason || "replace failed");
          setDirty(false);
          restoreScroll(editorHostRef.current, snap, followingGeneration());
        } catch {
          pendingScrollRef.current = snap;
          setEditorKey((k) => k + 1);
          mountFile(file);
        } finally {
          window.setTimeout(() => {
            replacingRef.current = Math.max(0, replacingRef.current - 1);
          }, 1000);
        }
      };
      replaceChainRef.current = replaceChainRef.current.then(run, run);
      return replaceChainRef.current;
    },
    [followingGeneration, mountFile],
  );

  const loadDraft = useCallback(
    async (id: string, p: PersonaKey = persona, opts: { quiet?: boolean } = {}) => {
      const seq = ++loadSeqRef.current;
      if (!opts.quiet) {
        setBusy(true);
        setError(null);
      }
      try {
        const [pack, full, file] = await Promise.all([
          listVersions(id, p),
          apiGet<{ draft: DraftRecord; session: DraftSession }>(`/drafts/${id}`, p),
          fetchDraftFile(id, p),
        ]);
        if (seq !== loadSeqRef.current) return;
        const prev = sessionRef.current;
        const sameDraft = draftIdRef.current === id;
        // The SuperDoc wrapper rebuilds itself whenever role or user change;
        // in that case the newest file must be the `document` in the same render.
        const sameEditor =
          REPLACE_IN_PLACE &&
          sameDraft &&
          readyRef.current &&
          !!prev &&
          prev.superdoc_role === full.session.superdoc_role &&
          prev.user.email === full.session.user.email &&
          prev.user.name === full.session.user.name;
        latestFileRef.current = file;
        draftIdRef.current = id;
        sessionRef.current = full.session;
        setDraftId(id);
        setSession(full.session);
        setDraftMeta(full.draft);
        setVersions(pack.versions || full.draft.versions || []);
        if (sameEditor) {
          await replaceInPlace(file);
        } else {
          if (!sameDraft) pendingScrollRef.current = null;
          mountFile(file);
        }
        void refreshLists(p);
      } catch (e) {
        if (seq === loadSeqRef.current) setError(errorText(e));
      } finally {
        if (!opts.quiet) setBusy(false);
      }
    },
    [persona, refreshLists, replaceInPlace, mountFile],
  );

  useEffect(() => {
    void refreshHealth();
    void refreshLists(persona);
  }, [refreshHealth, refreshLists, persona]);

  useEffect(() => {
    if (initialDraftId) void loadDraft(initialDraftId, persona);
  }, [initialDraftId]); // eslint-disable-line react-hooks/exhaustive-deps

  // A knowledge-graph document that resolves to a real draft opens it here.
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || openParamHandledRef.current === openId) return;
    openParamHandledRef.current = openId;
    void loadDraft(openId, persona);
  }, [searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  // "New draft from this" in the Reader arrives with the chosen highlights.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    const ids = (searchParams.get("ref") ?? "")
      .split(",")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    router.replace("/studio");
    setReferences([]);
    setNewDraftOpen(true);
    if (!ids.length) return;
    void listHighlights(persona)
      .then((res) =>
        setReferences(ids.map((id) => res.items.find((h) => h.id === id)).filter((h) => h !== undefined)),
      )
      .catch(() => setReferences([]));
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

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  const handleReady = useCallback(() => {
    readyRef.current = true;
    setReady(true);
    const snap = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (snap) restoreScroll(editorHostRef.current, snap, followingGeneration());
  }, [followingGeneration]);

  const handleEditorUpdate = useCallback(() => {
    if (!readyRef.current || replacingRef.current > 0) return;
    setDirty(true);
  }, []);

  const handleContentError = useCallback((payload: { error?: unknown }) => {
    console.error("[SuperDoc]", payload?.error);
    setError("This document couldn't be shown. Please reload the page.");
  }, []);

  // Exceptions after the document is on screen are usually recoverable, so
  // they are only logged; one during loading means the page is unusable.
  const handleException = useCallback((payload: { error?: unknown }) => {
    console.error("[SuperDoc]", payload?.error);
    if (!readyRef.current) setError("This document couldn't be shown. Please reload the page.");
  }, []);

  const handleStreamingChange = useCallback((s: boolean) => {
    if (!s && generatingRef.current) generationEndedAtRef.current = Date.now();
    generatingRef.current = s;
    setGenerating(s);
  }, []);

  const handleAgentDraftUpdated = useCallback(async () => {
    const id = draftIdRef.current;
    if (!id) return;
    await loadDraft(id, persona, { quiet: true });
    setThreadsRefreshKey((k) => k + 1);
  }, [loadDraft, persona]);

  const handleAutoRunConsumed = useCallback(() => setPendingGeneration(null), []);
  const handleThreadsChanged = useCallback(() => setThreadsRefreshKey((k) => k + 1), []);

  async function onCreate(
    title: string,
    brief: string,
    template: TemplateChoice,
    confidential: boolean,
    referenceIds: number[],
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await createDraft(
        persona,
        title,
        template.source === "catalog" ? template.templateCode : "BLANK",
        {
          ...(template.source === "corpus_doc"
            ? { templateSource: "corpus_doc" as const, corpusDocId: template.corpusDocId }
            : { templateSource: "catalog" as const }),
          aiRestricted: confidential,
          referenceHighlightIds: referenceIds,
        },
      );
      setNewDraftOpen(false);
      setReferences([]);
      // Without a brief there's no first draft to write, so the highlights go into the page itself.
      if (referenceIds.length && !brief.trim()) {
        try {
          await addExcerptToDraft(persona, res.draft.id, referenceIds);
        } catch (e) {
          setError(errorText(e));
        }
      }
      await loadDraft(res.draft.id, persona);
      if (brief.trim()) {
        setFocusGenerateSignal((n) => n + 1);
        setIntakeState({ draftId: res.draft.id, title, brief: brief.trim(), choice: llmChoice });
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSave(): Promise<boolean> {
    if (!draftId || !session?.can_save) return false;
    const instance = editorRef.current?.getInstance();
    if (!instance || !readyRef.current) {
      setError("Please wait for the document to load.");
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const exported = await instance.export({ exportType: ["docx"], triggerDownload: false });
      if (!(exported instanceof Blob) || exported.size < 100) {
        throw new Error("Couldn't save — please try again.");
      }
      const result = await saveDraftFile(draftId, persona, exported, "manual");
      setDirty(false);
      sessionRef.current = result.session;
      setSession(result.session);
      try {
        const extracted = extractSuperDocThreads(instance);
        if (extracted.length) await syncThreads(draftId, persona, extracted);
      } catch {
        // Comment mirroring is best effort; the document itself is saved.
      }
      flash(`Saved — version ${result.version}`);
      await loadDraft(draftId, persona, { quiet: true });
      setThreadsRefreshKey((k) => k + 1);
      return true;
    } catch (e) {
      const keep = e instanceof ApiError && [401, 403, 409].includes(e.status);
      setError(keep ? errorText(e) : "Couldn't save — please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onExportDownload() {
    const instance = editorRef.current?.getInstance();
    if (!instance) return;
    try {
      await instance.export({
        exportType: ["docx"],
        exportedName: safeFileName(documentTitle(draftMeta)),
        triggerDownload: true,
      });
    } catch {
      setError("Couldn't download the document — please try again.");
    }
  }

  async function onSubmit() {
    if (!draftId) return;
    if (session?.can_save && dirty && !(await onSave())) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson<{ session: DraftSession }>(`/drafts/${draftId}/submit`, persona, {
        method: "POST",
        body: "{}",
      });
      flash("Sent for first review");
      await loadDraft(draftId, persona, { quiet: true });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function decide(level: 1 | 2, decision: "approve" | DecisionKind, comment: string) {
    if (!draftId) return;
    if (session?.can_save && dirty && !(await onSave())) return;
    setBusy(true);
    setError(null);
    try {
      await decideDraft(draftId, persona, { level, decision, comments: comment });
      flash(
        decision === "approve"
          ? level === 1
            ? "Approved — sent for final approval"
            : "Final approval given"
          : decision === "changes_requested"
            ? "Returned for changes"
            : "Rejected",
      );
      setDecisionDialog(null);
      await loadDraft(draftId, persona, { quiet: true });
      setThreadsRefreshKey((k) => k + 1);
    } catch (e) {
      if (decision === "approve") setError(errorText(e));
      else throw e;
    } finally {
      setBusy(false);
    }
  }

  async function onPersonaChange(next: PersonaKey) {
    setPersona(next);
    if (draftId) await loadDraft(draftId, next);
  }

  function openDraft(id: string) {
    if (id === draftId) return;
    if (dirty && session?.can_save && !window.confirm("You have unsaved changes. Leave this document without saving?")) {
      return;
    }
    void loadDraft(id, persona);
  }

  function goHome() {
    if (dirty && session?.can_save && !window.confirm("You have unsaved changes. Leave this document without saving?")) {
      return;
    }
    loadSeqRef.current += 1;
    draftIdRef.current = undefined;
    sessionRef.current = null;
    latestFileRef.current = null;
    readyRef.current = false;
    setDraftId(undefined);
    setSession(null);
    setDraftMeta(null);
    setVersions([]);
    setDocFile(null);
    setReady(false);
    setDirty(false);
    setError(null);
    if (searchParams.get("draft") || searchParams.get("open")) router.replace("/studio");
    void refreshLists(persona);
  }

  async function insertCitationIntoDraft(hit: CorpusHit): Promise<string> {
    type SuperDocLike = {
      activeEditor?: {
        commands?: { focus: (pos: string) => void; insertContent: (html: string) => void };
        doc?: { insert?: (args: unknown) => Promise<void> | void };
      };
      doc?: { insert?: (args: unknown) => Promise<void> | void };
    };
    const instance = editorRef.current?.getInstance() as SuperDocLike | null | undefined;
    if (!instance || !readyRef.current) throw new Error("Please wait for the document to load.");
    if (!session?.can_save) throw new Error("You can't edit this document.");
    const quote = excerpt(hit.text || "");
    const ministry = hit.ministry && !/^unknown$/i.test(hit.ministry.trim()) ? hit.ministry.trim() : "";
    const source = [hit.title, ministry].filter(Boolean).join(", ");
    const plain = `“${quote}”\nSource: ${source}`;
    const html = `<p>“${escapeHtml(quote)}”</p><p><em>Source: ${escapeHtml(source)}</em></p>`;
    const attempts: Array<() => Promise<void>> = [
      async () => {
        const commands = instance.activeEditor?.commands;
        if (!commands?.insertContent) throw new Error("no insertContent");
        commands.focus("end");
        commands.insertContent(html);
      },
      async () => {
        const doc = instance.doc || instance.activeEditor?.doc;
        if (!doc?.insert) throw new Error("no doc.insert");
        await doc.insert({ target: { type: "end" }, content: plain });
      },
    ];
    for (const fn of attempts) {
      try {
        await fn();
        setDirty(true);
        return "Added to the document";
      } catch {
        // try the next way in
      }
    }
    try {
      await navigator.clipboard.writeText(plain);
      return "Copied — press Ctrl+V to paste into the document";
    } catch {
      throw new Error("Couldn't add the reference.");
    }
  }

  const fileRev = useMemo(
    () => (docFile ? `${docFile.name}-${docFile.size}-${docFile.lastModified}` : "none"),
    [docFile],
  );
  const userName = session?.user.name;
  const userEmail = session?.user.email;
  const editorUser = useMemo(
    () => ({ name: userName || "QCI user", email: userEmail || "user@qcin.org" }),
    [userName, userEmail],
  );

  const statusLine = session
    ? [
        `Version ${session.version}`,
        MODE_TEXT[session.document_mode] ?? "View only",
        dirty && session.can_save ? "Unsaved changes" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const otherDocs = drafts.filter((d) => d.draft.id !== draftId && !isEmptyUntitled(d.draft)).slice(0, 8);
  const newestFirst = [...versions].reverse();

  return (
    <div className="flex min-h-full flex-col gap-3 p-3 text-text lg:h-full lg:min-h-0 lg:p-4">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface-raised px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {draftId ? (
            <>
              <button
                type="button"
                onClick={goHome}
                disabled={generating}
                aria-label="All documents"
                title="All documents"
                className="shrink-0 rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-sunken hover:text-text disabled:opacity-50"
              >
                <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
                  <path d="M12.5 4.5L7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate font-display text-lg font-medium leading-tight">
                    {documentTitle(draftMeta)}
                  </h1>
                  {session && <StatusPill status={session.status} />}
                  {draftMeta?.ai_restricted && (
                    <span
                      title="Nothing in this document is sent to outside AI services"
                      className="shrink-0 rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-text-muted"
                    >
                      Confidential · no AI
                    </span>
                  )}
                </div>
                <p className="truncate text-[13px] text-text-muted" aria-live="polite">
                  {statusLine}
                  {notice && <span className="ml-2 font-medium text-status-approved-text">{notice}</span>}
                </p>
              </div>
            </>
          ) : (
            <p className="text-[13px] font-medium text-status-approved-text" aria-live="polite">
              {notice}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {draftId && session?.can_save && (
            <button
              type="button"
              disabled={locked || !ready}
              onClick={() => void onSave()}
              className={`${actionBtn} bg-accent text-white hover:bg-accent-hover`}
            >
              Save
            </button>
          )}
          {draftId && (
            <button
              type="button"
              disabled={!ready}
              onClick={() => void onExportDownload()}
              className={`${actionBtn} border border-border-strong text-text hover:bg-surface-sunken`}
            >
              Download
            </button>
          )}
          {draftId && session?.can_submit && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void onSubmit()}
              className={`${actionBtn} bg-action-changes text-white hover:bg-action-changes-hover`}
            >
              Submit for review
            </button>
          )}
          {draftId && (session?.can_decide_l1 || session?.can_decide_l2) && (
            <div className="flex items-center gap-1 rounded-lg border border-border bg-surface-sunken p-0.5">
              <button
                type="button"
                disabled={locked}
                onClick={() => void decide(session.can_decide_l2 ? 2 : 1, "approve", "Approved")}
                className={`${actionBtn} bg-action-approve py-1 text-white hover:bg-action-approve-hover`}
              >
                {session.can_decide_l2 ? "Give final approval" : "Approve"}
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() =>
                  setDecisionDialog({ level: session.can_decide_l2 ? 2 : 1, kind: "changes_requested" })
                }
                className={`${actionBtn} py-1 text-action-changes hover:bg-surface-raised`}
              >
                Request changes
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => setDecisionDialog({ level: session.can_decide_l2 ? 2 : 1, kind: "reject" })}
                className={`${actionBtn} py-1 text-action-reject hover:bg-surface-raised`}
              >
                Reject
              </button>
            </div>
          )}
          {draftId && (
            <button
              type="button"
              disabled={locked}
              onClick={() => setNewDraftOpen(true)}
              className={`${actionBtn} border border-border-strong text-text hover:bg-surface-sunken`}
            >
              New document
            </button>
          )}
          {personasMode && (
            <label className="flex items-center gap-1.5 whitespace-nowrap text-[13px] text-text-muted">
              Viewing as
              <select
                className="rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-[13px] text-text disabled:opacity-50"
                value={persona}
                disabled={locked}
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
          {me && (
            <div className="flex items-center gap-2 whitespace-nowrap text-[13px] text-text-muted">
              <span>
                Signed in as <span className="font-medium text-text">{me.name}</span>
              </span>
              <button
                type="button"
                onClick={() => void logout().then(() => router.push("/login"))}
                className="rounded-md border border-border-strong px-2 py-0.5 transition-colors hover:bg-surface-sunken hover:text-text"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>

      {(servicesDown || meError) && (
        <div
          role="status"
          className="shrink-0 rounded-lg border border-status-changes-border bg-status-changes-surface px-3 py-2 text-[13px] text-status-changes-text"
        >
          {meError ?? "Some services are unavailable. Please try again shortly."}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 rounded-lg border border-status-rejected-border bg-status-rejected-surface px-3 py-2 text-[13px] text-status-rejected-text"
        >
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss"
            className="rounded px-1 leading-none transition-colors hover:bg-status-rejected-border/40"
          >
            ×
          </button>
        </div>
      )}

      <DecisionModal
        open={decisionDialog !== null}
        kind={decisionDialog?.kind ?? "reject"}
        busy={busy}
        onCancel={() => setDecisionDialog(null)}
        onConfirm={async (comment) => {
          if (!decisionDialog) return;
          await decide(decisionDialog.level, decisionDialog.kind, comment);
        }}
      />

      <NewDraftModal
        open={newDraftOpen}
        persona={persona}
        busy={busy}
        choice={llmChoice}
        onChoiceChange={setLlmChoice}
        serverLlm={me?.server_llm}
        isAdmin={isAdmin}
        references={references}
        onRemoveReference={(id) => setReferences((rs) => rs.filter((r) => r.id !== id))}
        onCancel={() => {
          setNewDraftOpen(false);
          setReferences([]);
        }}
        onConfirm={onCreate}
      />

      {intakeState && (
        <DraftIntakeOverlay
          key={intakeState.draftId}
          open={true}
          draftId={intakeState.draftId}
          title={intakeState.title}
          brief={intakeState.brief}
          providerChoice={intakeState.choice}
          persona={persona}
          onComplete={(enrichedBrief) => {
            const { choice } = intakeState;
            setIntakeState(null);
            setPendingGeneration({ preset: "draft_generator", prompt: enrichedBrief, choice });
          }}
          onAbandon={() => setIntakeState(null)}
        />
      )}

      {!draftId ? (
        <StudioHome
          name={me?.name}
          drafts={drafts}
          inbox={inbox}
          loading={draftsLoading || busy}
          disabled={locked}
          onNew={() => setNewDraftOpen(true)}
          onOpen={openDraft}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[minmax(0,1fr)]">
          <section
            aria-label="Document"
            className="flex h-[75vh] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-sunken lg:h-auto"
          >
            <div
              ref={editorHostRef}
              key={REPLACE_IN_PLACE ? editorKey : fileRev}
              data-superdoc-theme="light"
              className="relative min-h-0 flex-1"
            >
              {docFile ? (
                <SuperDocEditor
                  ref={editorRef}
                  document={docFile}
                  documentMode={session?.document_mode ?? "viewing"}
                  role={session?.superdoc_role ?? "viewer"}
                  user={editorUser}
                  contained
                  zoom={EDITOR_ZOOM}
                  ui={EDITOR_UI}
                  uiDisplayFallbackFont={EDITOR_FONT}
                  onReady={handleReady}
                  onEditorUpdate={handleEditorUpdate}
                  onContentError={handleContentError}
                  onException={handleException}
                  style={{ height: "100%" }}
                />
              ) : (
                <DocumentSkeleton />
              )}
            </div>
          </section>

          <aside
            aria-label="Document tools"
            className="flex max-h-[85vh] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised lg:max-h-none"
          >
            <StudioSidebarTabs
              activateGenerateSignal={focusGenerateSignal}
              overview={
                <div className="space-y-5 text-[13px]">
                  <section>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <h2 className="text-sm font-semibold text-text">Versions</h2>
                      {versions.length >= 2 && (
                        <a
                          href={`/studio/diff?draft=${encodeURIComponent(draftId)}&from=${
                            versions[versions.length - 2].version
                          }&to=${versions[versions.length - 1].version}&persona=${persona}`}
                          className="text-accent hover:underline"
                        >
                          Compare last two
                        </a>
                      )}
                    </div>
                    <ul className="space-y-1 text-text-muted">
                      {newestFirst.length === 0 && <li>No versions yet</li>}
                      {newestFirst.map((v, i) => {
                        const prev = newestFirst[i + 1];
                        return (
                          <li key={v.version} className="flex items-center gap-2">
                            <span className="min-w-0 flex-1">{versionLabel(v)}</span>
                            {prev && (
                              <a
                                href={`/studio/diff?draft=${encodeURIComponent(draftId)}&from=${prev.version}&to=${v.version}&persona=${persona}`}
                                className="shrink-0 text-xs text-accent hover:underline"
                                aria-label={`Compare version ${prev.version} with version ${v.version}`}
                              >
                                Compare
                              </a>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </section>

                  <section>
                    <h2 className="mb-1.5 text-sm font-semibold text-text">Other documents</h2>
                    <ul className="space-y-1">
                      {otherDocs.length === 0 && <li className="text-text-muted">No other documents yet.</li>}
                      {otherDocs.map((item) => (
                        <li key={item.draft.id}>
                          <button
                            type="button"
                            disabled={locked}
                            onClick={() => openDraft(item.draft.id)}
                            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface-sunken disabled:opacity-50"
                          >
                            <span className="min-w-0 flex-1 truncate text-text">{documentTitle(item.draft)}</span>
                            <StatusPill status={item.draft.status} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              }
              generate={
                draftMeta?.ai_restricted ? (
                  <div className="m-3 rounded-lg border border-border bg-surface-sunken p-4 text-sm text-text">
                    <p className="font-medium">AI help is off for this document</p>
                    <p className="mt-1 text-text-muted">
                      It was marked confidential when it was created, so nothing in it is sent to outside AI
                      services. Writing, comments, review and approval all work as usual.
                    </p>
                  </div>
                ) : (
                  <AgentPanel
                    key={draftId}
                    draftId={draftId}
                    persona={persona}
                    superdocRole={session?.superdoc_role}
                    canRunAgent={Boolean(session?.can_run_agent_mutate)}
                    choice={llmChoice}
                    onChoiceChange={setLlmChoice}
                    serverLlm={me?.server_llm}
                    isAdmin={isAdmin}
                    onDraftUpdated={handleAgentDraftUpdated}
                    onThreadsChanged={handleThreadsChanged}
                    onStreamingChange={handleStreamingChange}
                    autoRun={pendingGeneration}
                    onAutoRunConsumed={handleAutoRunConsumed}
                  />
                )
              }
              research={
                <RagPanel
                  persona={persona}
                  draftId={draftId}
                  canInsert={Boolean(session?.can_save && ready)}
                  onInsertCitation={insertCitationIntoDraft}
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
              corpus={isAdmin ? <CorpusUploader persona={persona} isAdmin={isAdmin} /> : undefined}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
