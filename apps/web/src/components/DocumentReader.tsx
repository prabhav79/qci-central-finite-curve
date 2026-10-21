"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PERSONAS,
  type CorpusHit,
  type InsertableDraft,
  type LibraryDoc,
  type PersonaKey,
  type ReaderDocument,
  type ReaderHighlight,
  addExcerptToDraft,
  corpusSearch,
  createHighlight,
  deleteHighlight,
  errorText,
  getReaderDocument,
  isPersonasMode,
  listHighlights,
  listInsertableDrafts,
  readerPdfSource,
  updateHighlightNote,
} from "@/lib/cfcApi";
import { formatDateIST } from "@/lib/dates";
import { useCurrentUser } from "@/lib/useCurrentUser";
import type { NewSelection, PdfSource, PdfViewerHandle } from "./PdfViewer";
import { statusLabel } from "./StatusPill";

const PdfViewer = dynamic(() => import("./PdfViewer").then((m) => m.PdfViewer), {
  ssr: false,
  loading: () => <div className="p-6 text-sm text-text-muted">Opening the document…</div>,
});

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function docDate(value?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : (value ?? "");
}

export function rupees(value?: number | null): string {
  return value ? `₹${Math.round(value).toLocaleString("en-IN")}` : "";
}

export function OutcomeBadge({ doc }: { doc: Pick<LibraryDoc, "outcome" | "outcome_label"> }) {
  if (!doc.outcome_label) return null;
  const tone =
    doc.outcome === "successful"
      ? "bg-status-approved-surface text-status-approved-text border-status-approved-border"
      : doc.outcome === "unsuccessful"
        ? "bg-status-rejected-surface text-status-rejected-text border-status-rejected-border"
        : "bg-surface-sunken text-text-muted border-border";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`}>{doc.outcome_label}</span>
  );
}

function citation(h: ReaderHighlight, title: string): string {
  return `“${h.quote}”\n— ${title}, p. ${h.page}`;
}

export function DocumentReader() {
  const { me } = useCurrentUser();
  const router = useRouter();
  const params = useSearchParams();
  const docId = params.get("doc");
  const startPage = Number(params.get("page")) || undefined;
  const startFind = params.get("find") || undefined;
  const [persona, setPersona] = useState<PersonaKey>("arpit");

  if (!docId) {
    return <ReaderHome persona={persona} me={me} setPersona={setPersona} />;
  }
  return (
    <ReaderDocumentView
      key={`${docId}:${persona}`}
      docId={docId}
      persona={persona}
      startPage={startPage}
      startFind={startFind}
      personaPicker={
        isPersonasMode(me) ? <PersonaPicker persona={persona} setPersona={setPersona} /> : null
      }
      onOpen={(id) => router.push(`/studio/reader?doc=${encodeURIComponent(id)}`)}
    />
  );
}

export function PersonaPicker({ persona, setPersona }: { persona: PersonaKey; setPersona: (p: PersonaKey) => void }) {
  return (
    <label className="text-[13px] text-text-muted">
      Viewing as
      <select
        className="ml-2 rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-[13px] text-text"
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
  );
}

function ReaderDocumentView({
  docId,
  persona,
  startPage,
  startFind,
  personaPicker,
  onOpen,
}: {
  docId: string;
  persona: PersonaKey;
  startPage?: number;
  startFind?: string;
  personaPicker: React.ReactNode;
  onOpen: (docId: string) => void;
}) {
  const router = useRouter();
  const viewer = useRef<PdfViewerHandle | null>(null);
  const [info, setInfo] = useState<ReaderDocument | null>(null);
  const [source, setSource] = useState<PdfSource | null>(null);
  const [highlights, setHighlights] = useState<ReaderHighlight[]>([]);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(startPage ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"highlights" | "about">("highlights");
  const [findText, setFindText] = useState(startFind ?? "");
  const [popover, setPopover] = useState<{ id: number; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [toast, setToast] = useState<{ text: string; href?: string } | null>(null);
  const toastTimer = useRef<number | null>(null);

  const title = info?.document.title ?? "";

  /** Shows a short message; a sticky one stays until the next message replaces it. */
  const say = useCallback((text: string, href?: string, sticky = false) => {
    setToast({ text, href });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (!sticky) toastTimer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [doc, hl] = await Promise.all([getReaderDocument(persona, docId), listHighlights(persona, docId)]);
        if (cancelled) return;
        setInfo(doc);
        setHighlights(hl.items);
        setSource(await readerPdfSource(persona, doc.file_url));
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, persona]);

  const onSelect = useCallback(
    async (sel: NewSelection) => {
      const temp: ReaderHighlight = { id: -Date.now(), doc_id: docId, page: sel.page, rects: sel.rects, quote: sel.quote };
      setHighlights((hs) => [...hs, temp]);
      setTab("highlights");
      try {
        const saved = await createHighlight(persona, { doc_id: docId, ...sel });
        setHighlights((hs) => hs.map((h) => (h.id === temp.id ? saved : h)));
      } catch (e) {
        setHighlights((hs) => hs.filter((h) => h.id !== temp.id));
        say(errorText(e));
      }
    },
    [docId, persona, say],
  );

  const remove = useCallback(
    async (id: number) => {
      const before = highlights;
      setHighlights((hs) => hs.filter((h) => h.id !== id));
      setSelected((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      setPopover(null);
      try {
        await deleteHighlight(persona, id);
      } catch (e) {
        setHighlights(before);
        say(errorText(e));
      }
    },
    [highlights, persona, say],
  );

  const copy = useCallback(
    async (h: ReaderHighlight) => {
      try {
        await navigator.clipboard.writeText(citation(h, title));
        say("Copied, with its source");
      } catch {
        say("Copying isn't allowed here. Select the text in the list instead.");
      }
    },
    [say, title],
  );

  const saveNote = useCallback(
    async (id: number, note: string) => {
      setHighlights((hs) => hs.map((h) => (h.id === id ? { ...h, note } : h)));
      try {
        await updateHighlightNote(persona, id, note);
      } catch (e) {
        say(errorText(e));
      }
    },
    [persona, say],
  );

  const insertInto = useCallback(
    async (h: ReaderHighlight, draft: InsertableDraft) => {
      say(`Adding to “${draft.title}”…`, undefined, true);
      try {
        await addExcerptToDraft(persona, draft.id, h.id);
        say(`Added to the end of “${draft.title}”`, `/studio?open=${encodeURIComponent(draft.id)}`);
      } catch (e) {
        say(errorText(e));
      }
    },
    [persona, say],
  );

  const startDraft = useCallback(
    (ids: number[]) =>
      router.push(`/studio?new=1&ref=${ids.filter((i) => i > 0).join(",")}&persona=${encodeURIComponent(persona)}`),
    [router, persona],
  );

  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPopover(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popover]);

  const sorted = useMemo(
    () => [...highlights].sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0)),
    [highlights],
  );
  const popoverHighlight = popover ? highlights.find((h) => h.id === popover.id) : undefined;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
          <Link href="/studio/library" className="rounded px-1.5 py-1 text-[13px] text-text-muted hover:bg-surface-sunken hover:text-text">
            ← Library
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 title={title} className="truncate font-display text-base font-medium">{title || "Opening…"}</h1>
            {info && <OutcomeBadge doc={info.document} />}
          </div>
          <div className="flex items-center gap-1 text-[13px] text-text-muted">
            <button type="button" aria-label="Previous page" className="rounded px-2 py-1 hover:bg-surface-sunken" onClick={() => viewer.current?.goToPage(Math.max(1, page - 1))}>‹</button>
            <span className="tabular-nums">{pages ? `Page ${page} of ${pages}` : ""}</span>
            <button type="button" aria-label="Next page" className="rounded px-2 py-1 hover:bg-surface-sunken" onClick={() => viewer.current?.goToPage(Math.min(pages || 1, page + 1))}>›</button>
            <span className="mx-1 h-4 w-px bg-border" />
            <button type="button" aria-label="Zoom out" className="rounded px-2 py-1 hover:bg-surface-sunken" onClick={() => viewer.current?.zoomOut()}>−</button>
            <button type="button" className="rounded px-2 py-1 hover:bg-surface-sunken" onClick={() => viewer.current?.fitWidth()}>Fit</button>
            <button type="button" aria-label="Zoom in" className="rounded px-2 py-1 hover:bg-surface-sunken" onClick={() => viewer.current?.zoomIn()}>+</button>
          </div>
          <input
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && findText.trim()) viewer.current?.find(findText.trim(), true);
            }}
            placeholder="Find in document"
            aria-label="Find in document"
            className="w-44 rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
          />
          {personaPicker}
        </div>
        <div className="relative min-h-0 flex-1">
          {error ? (
            <div className="m-6 rounded-lg border border-border bg-surface-raised p-4 text-sm text-text">{error}</div>
          ) : source ? (
            <PdfViewer
              ref={viewer}
              source={source}
              highlights={highlights}
              initialPage={startPage}
              initialFind={startFind}
              onSelect={(sel) => void onSelect(sel)}
              onHighlightClick={(id, at) => setPopover({ id, ...at })}
              onLoaded={({ pages: n }) => setPages(n)}
              onPageChange={setPage}
              onError={setError}
            />
          ) : (
            <div className="p-6 text-sm text-text-muted">Opening the document…</div>
          )}
        </div>
      </div>

      <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-surface-raised">
        <div className="flex shrink-0 gap-1 border-b border-border p-2" role="tablist">
          {(["highlights", "about"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1.5 text-[13px] font-medium ${tab === t ? "bg-accent/10 text-accent" : "text-text-muted hover:bg-surface-sunken"}`}
            >
              {t === "highlights" ? `Your highlights${highlights.length ? ` (${highlights.length})` : ""}` : "About"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "highlights" ? (
            sorted.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-muted">
                Select any text in the document to highlight it. Your highlights are private to you, and you can
                start a new draft from them or add them to one of your drafts.
              </p>
            ) : (
              <ul className="space-y-3">
                {sorted.map((h) => (
                  <HighlightCard
                    key={h.id}
                    h={h}
                    persona={persona}
                    checked={selected.has(h.id)}
                    onCheck={(on) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (on) next.add(h.id);
                        else next.delete(h.id);
                        return next;
                      })
                    }
                    onShow={() => viewer.current?.showHighlight(h)}
                    onCopy={() => void copy(h)}
                    onRemove={() => void remove(h.id)}
                    onNote={(note) => void saveNote(h.id, note)}
                    onInsert={(d) => void insertInto(h, d)}
                    onStartDraft={() => startDraft([h.id])}
                  />
                ))}
              </ul>
            )
          ) : (
            info && <AboutPanel info={info} current={docId} onOpen={onOpen} />
          )}
        </div>
        {tab === "highlights" && selected.size > 0 && (
          <div className="flex shrink-0 items-center gap-2 border-t border-border p-3">
            <span className="text-[13px] text-text-muted">{selected.size} selected</span>
            <button
              type="button"
              onClick={() => startDraft(sorted.filter((h) => selected.has(h.id)).map((h) => h.id))}
              className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              New draft from these
            </button>
          </div>
        )}
      </aside>

      {popover && popoverHighlight && (
        <div className="fixed inset-0 z-40" onClick={() => setPopover(null)}>
          <div
            className="absolute flex gap-1 rounded-lg border border-border bg-surface-raised p-1 shadow-lg"
            style={{ left: popover.x, top: popover.y + 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="rounded px-2 py-1 text-[13px] hover:bg-surface-sunken" onClick={() => { void copy(popoverHighlight); setPopover(null); }}>
              Copy
            </button>
            <button type="button" className="rounded px-2 py-1 text-[13px] hover:bg-surface-sunken" onClick={() => { setTab("highlights"); setPopover(null); }}>
              Show in list
            </button>
            <button type="button" className="rounded px-2 py-1 text-[13px] text-status-rejected-text hover:bg-surface-sunken" onClick={() => void remove(popoverHighlight.id)}>
              Remove
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-text px-4 py-2 text-[13px] text-surface shadow-lg" role="status">
          {toast.text}
          {toast.href && (
            <Link href={toast.href} className="font-medium underline">
              Open draft
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function HighlightCard({
  h,
  persona,
  checked,
  onCheck,
  onShow,
  onCopy,
  onRemove,
  onNote,
  onInsert,
  onStartDraft,
}: {
  h: ReaderHighlight;
  persona: PersonaKey;
  checked: boolean;
  onCheck: (on: boolean) => void;
  onShow: () => void;
  onCopy: () => void;
  onRemove: () => void;
  onNote: (note: string) => void;
  onInsert: (d: InsertableDraft) => void;
  onStartDraft: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(h.note ?? "");
  const [menu, setMenu] = useState<InsertableDraft[] | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const saving = h.id < 0;

  async function openMenu() {
    if (menu) {
      setMenu(null);
      return;
    }
    setMenuError(null);
    try {
      setMenu((await listInsertableDrafts(persona)).items);
    } catch (e) {
      setMenuError(errorText(e));
    }
  }

  return (
    <li className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label="Select this highlight"
          checked={checked}
          disabled={saving}
          onChange={(e) => onCheck(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-accent"
        />
        <button type="button" onClick={onShow} className="min-w-0 flex-1 text-left">
          <p className="line-clamp-5 border-l-[3px] border-[#F2C200] pl-2 text-sm text-text">{h.quote}</p>
          <p className="mt-1 text-xs text-text-muted">Page {h.page}{saving ? " · saving…" : ""}</p>
        </button>
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why this matters, or how you'll use it"
            className="w-full resize-none rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
          />
          <div className="mt-1 flex justify-end gap-2 text-[13px]">
            <button type="button" className="text-text-muted" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="font-medium text-accent" onClick={() => { onNote(note); setEditing(false); }}>Save note</button>
          </div>
        </div>
      ) : (
        h.note && <p className="mt-2 rounded bg-surface-sunken px-2 py-1 text-[13px] text-text-muted">{h.note}</p>
      )}
      {!saving && (
        <div className="relative mt-2 flex flex-wrap gap-1 text-[13px]">
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={onCopy}>Copy</button>
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={() => void openMenu()}>
            Insert into draft ▾
          </button>
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={onStartDraft}>New draft from this</button>
          <button type="button" className="rounded px-2 py-0.5 text-text-muted hover:bg-surface-sunken" onClick={() => setEditing(true)}>{h.note ? "Edit note" : "Add note"}</button>
          <button type="button" className="rounded px-2 py-0.5 text-status-rejected-text hover:bg-surface-sunken" onClick={onRemove}>Remove</button>
          {(menu || menuError) && (
            <div className="absolute left-0 top-full z-20 mt-1 w-full rounded-lg border border-border bg-surface-raised p-1 shadow-lg">
              {menuError ? (
                <p className="p-2 text-[13px] text-status-rejected-text">{menuError}</p>
              ) : menu && menu.length === 0 ? (
                <p className="p-2 text-[13px] text-text-muted">You have no drafts you can edit right now.</p>
              ) : (
                menu?.slice(0, 10).map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-sunken"
                    onClick={() => {
                      setMenu(null);
                      onInsert(d);
                    }}
                  >
                    <span className="block truncate text-[13px] text-text">{d.title}</span>
                    <span className="block text-xs text-text-muted">
                      {[statusLabel(d.status), d.updated_at ? formatDateIST(d.updated_at) : ""].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function DocRow({ d, current, onOpen }: { d: LibraryDoc; current?: boolean; onOpen: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        disabled={current}
        onClick={() => onOpen(d.doc_id)}
        className={`w-full rounded-lg px-2 py-1.5 text-left ${current ? "bg-accent/10" : "hover:bg-surface-sunken"}`}
      >
        <span className="block text-[13px] text-text">{d.title}</span>
        <span className="flex items-center gap-2 text-xs text-text-muted">
          {[d.doc_type, docDate(d.date)].filter(Boolean).join(" · ")}
          <OutcomeBadge doc={d} />
        </span>
      </button>
    </li>
  );
}

function AboutPanel({ info, current, onOpen }: { info: ReaderDocument; current: string; onOpen: (id: string) => void }) {
  const d = info.document;
  const rows: [string, string | null | undefined][] = [
    ["Client", d.client],
    ["Sector", d.sector],
    ["Type of work", d.work_type],
    ["Document", d.doc_type],
    ["State", d.state],
    ["Date", docDate(d.date)],
    ["Value", rupees(d.value_inr)],
  ];
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-muted">{k}</dt>
              <dd className="text-text">{v}</dd>
            </div>
          ))}
        <dt className="text-text-muted">Outcome</dt>
        <dd>{d.outcome_label ? <OutcomeBadge doc={d} /> : <span className="text-text-muted">Not recorded</span>}</dd>
      </dl>
      {info.series.length > 0 && (
        <section>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
            In this engagement · {d.engagement}
          </h2>
          <ol className="space-y-0.5 border-l border-border pl-2">
            {info.series.map((s) => (
              <DocRow key={s.doc_id} d={s} current={s.doc_id === current} onOpen={onOpen} />
            ))}
          </ol>
        </section>
      )}
      {info.similar.length > 0 && (
        <section>
          <h2 className="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">Similar documents</h2>
          <ul className="space-y-0.5">
            {info.similar.map((s) => (
              <DocRow key={s.doc_id} d={s} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ReaderHome({
  persona,
  me,
  setPersona,
}: {
  persona: PersonaKey;
  me: ReturnType<typeof useCurrentUser>["me"];
  setPersona: (p: PersonaKey) => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CorpusHit[]>([]);
  const [recent, setRecent] = useState<ReaderHighlight[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listHighlights(persona)
      .then((r) => setRecent(r.items))
      .catch(() => setRecent([]));
  }, [persona]);

  async function search() {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await corpusSearch(query.trim(), 30, persona);
      const seen = new Set<string>();
      setHits(res.hits.filter((h) => !seen.has(h.doc_id) && seen.add(h.doc_id)).slice(0, 12));
    } finally {
      setBusy(false);
    }
  }

  const byDoc = useMemo(() => {
    const m = new Map<string, { title: string; count: number }>();
    for (const h of recent) {
      const e = m.get(h.doc_id) ?? { title: h.doc_title ?? h.doc_id, count: 0 };
      e.count += 1;
      m.set(h.doc_id, e);
    }
    return [...m.entries()].slice(0, 8);
  }, [recent]);

  const open = (id: string) => router.push(`/studio/reader?doc=${encodeURIComponent(id)}`);

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight">Reader</h1>
          <p className="mt-1 text-sm text-text-muted">
            Read QCI&apos;s past documents in full, highlight what&apos;s useful, and start a draft from it.
          </p>
        </div>
        {isPersonasMode(me) && <div className="ml-auto"><PersonaPicker persona={persona} setPersona={setPersona} /></div>}
      </header>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Find a document, e.g. grievance PMU staffing"
          aria-label="Find a document"
          className="flex-1 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
        <button type="button" onClick={() => void search()} disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50">
          {busy ? "Searching…" : "Search"}
        </button>
        <Link href="/studio/library" className="rounded-lg border border-border-strong px-4 py-2 text-sm text-text hover:bg-surface-sunken">
          Browse the Library
        </Link>
      </div>
      {hits.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
          {hits.map((h) => (
            <li key={h.doc_id}>
              <button type="button" onClick={() => open(h.doc_id)} className="w-full px-4 py-3 text-left hover:bg-surface-sunken">
                <span className="block text-sm font-medium text-text">{h.title}</span>
                <span className="text-xs text-text-muted">{h.ministry}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {byDoc.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Where you&apos;ve highlighted</h2>
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
            {byDoc.map(([id, e]) => (
              <li key={id}>
                <button type="button" onClick={() => open(id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-sunken">
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{e.title}</span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {e.count} highlight{e.count === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
