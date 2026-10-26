"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PERSONAS,
  type CorpusHit,
  type LibraryDoc,
  type PersonaKey,
  type ReaderDocument,
  type ReaderHighlight,
  type ReaderSessionInfo,
  corpusSearch,
  createHighlight,
  deleteHighlight,
  errorText,
  getReaderDocument,
  isPersonasMode,
  listHighlights,
  readerPdfSource,
  startFreshSession,
} from "@/lib/cfcApi";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { HighlightsPanel, useToast } from "./HighlightsPanel";
import type { NewSelection, PdfSource, PdfViewerHandle } from "./PdfViewer";

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

export function DocumentReader() {
  const { me } = useCurrentUser();
  const router = useRouter();
  const params = useSearchParams();
  const docId = params.get("doc");
  const startPage = Number(params.get("page")) || undefined;
  const startFind = params.get("find") || undefined;
  const startHighlight = Number(params.get("hl")) || undefined;
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
      startHighlight={startHighlight}
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

/** Link to a highlight: its document, opened at the passage. */
export function highlightHref(h: Pick<ReaderHighlight, "id" | "doc_id" | "page">): string {
  return `/studio/reader?doc=${encodeURIComponent(h.doc_id)}&page=${h.page}&hl=${h.id}`;
}

/** All of the person's highlights plus their reading session, kept in step with the server. */
function useHighlights(persona: PersonaKey, say: (text: string) => void) {
  const [items, setItems] = useState<ReaderHighlight[]>([]);
  const [session, setSession] = useState<ReaderSessionInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await listHighlights(persona);
      setItems((current) => [...current.filter((h) => h.id < 0), ...res.items]);
      setSession(res.session);
    } catch (e) {
      say(errorText(e));
    } finally {
      setLoaded(true);
    }
  }, [persona, say]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (id: number) => {
      let before: ReaderHighlight[] = [];
      setItems((hs) => {
        before = hs;
        return hs.filter((h) => h.id !== id);
      });
      try {
        await deleteHighlight(persona, id);
      } catch (e) {
        setItems(before);
        say(errorText(e));
      }
    },
    [persona, say],
  );

  const startFresh = useCallback(async () => {
    try {
      setSession((await startFreshSession(persona)).session);
      setItems((hs) => hs.map((h) => ({ ...h, in_session: false })));
    } catch (e) {
      say(errorText(e));
    }
  }, [persona, say]);

  return { items, setItems, session, loaded, refresh, remove, startFresh };
}

function ReaderDocumentView({
  docId,
  persona,
  startPage,
  startFind,
  startHighlight,
  personaPicker,
  onOpen,
}: {
  docId: string;
  persona: PersonaKey;
  startPage?: number;
  startFind?: string;
  startHighlight?: number;
  personaPicker: React.ReactNode;
  onOpen: (docId: string) => void;
}) {
  const router = useRouter();
  const viewer = useRef<PdfViewerHandle | null>(null);
  const [toast, say] = useToast();
  const hl = useHighlights(persona, say);
  const { items, setItems, refresh } = hl;
  const [info, setInfo] = useState<ReaderDocument | null>(null);
  const [source, setSource] = useState<PdfSource | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(startPage ?? 1);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"highlights" | "about">("highlights");
  const [findText, setFindText] = useState(startFind ?? "");
  const [popover, setPopover] = useState<{ id: number; x: number; y: number } | null>(null);
  const shownOnArrival = useRef(false);

  const title = info?.document.title ?? "";
  const docHighlights = useMemo(() => items.filter((h) => h.doc_id === docId), [items, docId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const doc = await getReaderDocument(persona, docId);
        if (cancelled) return;
        setInfo(doc);
        setSource(await readerPdfSource(persona, doc.file_url));
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, persona]);

  // Arriving from a highlight listed under another document: take the reader to it.
  useEffect(() => {
    if (shownOnArrival.current || !startHighlight || !pages || !hl.loaded) return;
    const h = docHighlights.find((x) => x.id === startHighlight);
    if (!h) return;
    shownOnArrival.current = true;
    window.setTimeout(() => viewer.current?.showHighlight(h), 300);
  }, [startHighlight, pages, hl.loaded, docHighlights]);

  const onSelect = useCallback(
    async (sel: NewSelection) => {
      const temp: ReaderHighlight = {
        id: -Date.now(),
        doc_id: docId,
        doc_title: title,
        page: sel.page,
        rects: sel.rects,
        quote: sel.quote,
        created_at: new Date().toISOString(),
        in_session: true,
      };
      setItems((hs) => [temp, ...hs]);
      setTab("highlights");
      try {
        const saved = await createHighlight(persona, { doc_id: docId, ...sel });
        setItems((hs) => hs.map((h) => (h.id === temp.id ? saved : h)));
        void refresh(); // the first highlight after a break starts a new session
      } catch (e) {
        setItems((hs) => hs.filter((h) => h.id !== temp.id));
        say(errorText(e));
      }
    },
    [docId, title, persona, say, setItems, refresh],
  );

  const showHighlight = useCallback(
    (h: ReaderHighlight) => {
      if (h.doc_id === docId) viewer.current?.showHighlight(h);
      else router.push(highlightHref(h));
    },
    [docId, router],
  );

  useEffect(() => {
    if (!popover) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPopover(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [popover]);

  const popoverHighlight = popover ? items.find((h) => h.id === popover.id) : undefined;

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
              highlights={docHighlights}
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

      <aside className="flex w-[400px] shrink-0 flex-col border-l border-border bg-surface-raised">
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
              {t === "highlights" ? `Your highlights${items.length ? ` (${items.length})` : ""}` : "About"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {tab === "highlights" ? (
            <HighlightsPanel
              persona={persona}
              items={items}
              setItems={setItems}
              session={hl.session}
              onStartFresh={() => void hl.startFresh()}
              currentDocId={docId}
              onShow={showHighlight}
              onRemove={(id) => void hl.remove(id)}
              say={say}
            />
          ) : (
            <div className="h-full overflow-y-auto p-3">{info && <AboutPanel info={info} current={docId} onOpen={onOpen} />}</div>
          )}
        </div>
      </aside>

      {popover && popoverHighlight && (
        <div className="fixed inset-0 z-40" onClick={() => setPopover(null)}>
          <div
            className="absolute flex gap-1 rounded-lg border border-border bg-surface-raised p-1 shadow-lg"
            style={{ left: popover.x, top: popover.y + 8 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="rounded px-2 py-1 text-[13px] hover:bg-surface-sunken"
              onClick={() => {
                navigator.clipboard
                  .writeText(`“${popoverHighlight.quote}”\n— ${title}, p. ${popoverHighlight.page}`)
                  .then(() => say("Copied, with its source"))
                  .catch(() => say("Copying isn't allowed here. Select the text in the list instead."));
                setPopover(null);
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-[13px] hover:bg-surface-sunken"
              onClick={() => {
                setTab("highlights");
                setPopover(null);
                window.setTimeout(
                  () => document.getElementById(`hl-card-${popoverHighlight.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
                  50,
                );
              }}
            >
              Show in list
            </button>
            <button
              type="button"
              className="rounded px-2 py-1 text-[13px] text-status-rejected-text hover:bg-surface-sunken"
              onClick={() => {
                void hl.remove(popoverHighlight.id);
                setPopover(null);
              }}
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {toast}
    </div>
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
  const [toast, say] = useToast();
  const hl = useHighlights(persona, say);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CorpusHit[]>([]);
  const [busy, setBusy] = useState(false);

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
      {hl.loaded && (
        <section aria-label="Your highlights">
          <h2 className="mb-3 font-display text-lg font-medium">Your highlights</h2>
          <HighlightsPanel
            persona={persona}
            items={hl.items}
            setItems={hl.setItems}
            session={hl.session}
            onStartFresh={() => void hl.startFresh()}
            onShow={(h) => router.push(highlightHref(h))}
            onRemove={(id) => void hl.remove(id)}
            say={say}
            variant="page"
          />
        </section>
      )}
      {toast}
    </div>
  );
}
