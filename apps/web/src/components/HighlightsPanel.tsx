"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type InsertableDraft,
  type PersonaKey,
  type ReaderHighlight,
  type ReaderSessionInfo,
  addExcerptToDraft,
  errorText,
  listInsertableDrafts,
  updateHighlightNote,
} from "@/lib/cfcApi";
import { formatDateIST } from "@/lib/dates";
import { statusLabel } from "./StatusPill";

type Say = (text: string, href?: string, sticky?: boolean) => void;

/** A short message at the bottom of the screen; a sticky one stays until the next replaces it. */
export function useToast(): [React.ReactNode, Say] {
  const [toast, setToast] = useState<{ text: string; href?: string } | null>(null);
  const timer = useRef<number | null>(null);
  const say = useCallback<Say>((text, href, sticky = false) => {
    setToast({ text, href });
    if (timer.current) window.clearTimeout(timer.current);
    if (!sticky) timer.current = window.setTimeout(() => setToast(null), 6000);
  }, []);
  const node = toast && (
    <div
      className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-text px-4 py-2 text-[13px] text-surface shadow-lg"
      role="status"
    >
      {toast.text}
      {toast.href && (
        <Link href={toast.href} className="font-medium underline">
          Open draft
        </Link>
      )}
    </div>
  );
  return [node, say];
}

/** Where a highlight sits: page, then its first line's position on the page. */
function readingOrder(a: ReaderHighlight, b: ReaderHighlight): number {
  return a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0);
}

const newestFirst = (a: ReaderHighlight, b: ReaderHighlight) =>
  (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id;

function citation(h: ReaderHighlight): string {
  return `“${h.quote}”\n— ${h.doc_title ?? h.doc_id}, p. ${h.page}`;
}

/** The same layout the draft gets: grouped by document, page order, notes beneath. */
function citationsText(items: ReaderHighlight[]): string {
  const groups = new Map<string, ReaderHighlight[]>();
  for (const h of items) groups.set(h.doc_title ?? h.doc_id, [...(groups.get(h.doc_title ?? h.doc_id) ?? []), h]);
  const parts: string[] = [];
  for (const [title, hs] of groups) {
    parts.push(title);
    for (const h of [...hs].sort(readingOrder)) {
      parts.push(`“${h.quote}” (p. ${h.page})`);
      if (h.note?.trim()) parts.push(`Note: ${h.note.trim()}`);
    }
    parts.push("");
  }
  return parts.join("\n").trim();
}

function matches(h: ReaderHighlight, q: string): boolean {
  return [h.quote, h.note, h.doc_title].some((s) => s?.toLowerCase().includes(q));
}

function useStoredSelection(persona: PersonaKey): [Set<number>, (next: Set<number>) => void] {
  const key = `cfc.reader.selection.${persona}`;
  const [selected, setSelected] = useState<Set<number>>(() => {
    try {
      return new Set<number>(JSON.parse(window.sessionStorage.getItem(key) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const update = useCallback(
    (next: Set<number>) => {
      setSelected(next);
      try {
        window.sessionStorage.setItem(key, JSON.stringify([...next]));
      } catch {
        /* selection just won't survive a page change */
      }
    },
    [key],
  );
  return [selected, update];
}

/**
 * Every highlight the person has made, in two parts: this reading session
 * (newest first) and earlier ones (grouped by document). Highlights can be
 * picked across documents and added to a draft, or start one, in one go.
 */
export function HighlightsPanel({
  persona,
  items,
  setItems,
  session,
  onStartFresh,
  currentDocId,
  onShow,
  onRemove,
  say,
  variant = "sidebar",
}: {
  persona: PersonaKey;
  items: ReaderHighlight[];
  setItems: React.Dispatch<React.SetStateAction<ReaderHighlight[]>>;
  session: ReaderSessionInfo | null;
  onStartFresh: () => void;
  currentDocId?: string;
  onShow: (h: ReaderHighlight) => void;
  onRemove: (id: number) => void;
  say: Say;
  variant?: "sidebar" | "page";
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selectedRaw, setSelected] = useStoredSelection(persona);
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentDocId ? [currentDocId] : []));
  const [menu, setMenu] = useState<InsertableDraft[] | null>(null);
  const [busy, setBusy] = useState(false);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? items.filter((h) => matches(h, q)) : items), [items, q]);
  const sessionItems = useMemo(() => visible.filter((h) => h.in_session).sort(newestFirst), [visible]);
  const earlierGroups = useMemo(() => {
    const groups = new Map<string, ReaderHighlight[]>();
    for (const h of visible.filter((x) => !x.in_session)) groups.set(h.doc_id, [...(groups.get(h.doc_id) ?? []), h]);
    return [...groups.entries()]
      .map(([docId, hs]) => ({ docId, title: hs[0].doc_title ?? docId, items: [...hs].sort(readingOrder), last: [...hs].sort(newestFirst)[0] }))
      .sort((a, b) => (a.docId === currentDocId ? -1 : b.docId === currentDocId ? 1 : newestFirst(a.last, b.last)));
  }, [visible, currentDocId]);
  const earlierCount = earlierGroups.reduce((n, g) => n + g.items.length, 0);

  // Only highlights that still exist (and are saved) count as selected.
  const selected = useMemo(() => new Set(items.filter((h) => h.id > 0 && selectedRaw.has(h.id)).map((h) => h.id)), [items, selectedRaw]);
  const chosen = useMemo(
    // Oldest first, so documents appear in the draft in the order they were read.
    () => items.filter((h) => selected.has(h.id)).sort((a, b) => -newestFirst(a, b)),
    [items, selected],
  );

  const toggle = (ids: number[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (id <= 0) continue;
      if (on) next.add(id);
      else next.delete(id);
    }
    setSelected(next);
  };
  const allIn = (hs: ReaderHighlight[]) => hs.length > 0 && hs.every((h) => selected.has(h.id));

  const saveNote = useCallback(
    async (id: number, note: string) => {
      setItems((hs) => hs.map((h) => (h.id === id ? { ...h, note } : h)));
      try {
        await updateHighlightNote(persona, id, note);
      } catch (e) {
        say(errorText(e));
      }
    },
    [persona, say, setItems],
  );

  const copy = useCallback(
    async (text: string, done: string) => {
      try {
        await navigator.clipboard.writeText(text);
        say(done);
      } catch {
        say("Copying isn't allowed here. Select the text in the list instead.");
      }
    },
    [say],
  );

  const insert = useCallback(
    async (hs: ReaderHighlight[], draft: InsertableDraft) => {
      setBusy(true);
      say(`Adding ${hs.length === 1 ? "1 excerpt" : `${hs.length} excerpts`} to “${draft.title}”…`, undefined, true);
      try {
        await addExcerptToDraft(persona, draft.id, hs.map((h) => h.id));
        say(`Added under “Reference excerpts” in “${draft.title}”`, `/studio?open=${encodeURIComponent(draft.id)}`);
        if (hs.length > 1) setSelected(new Set());
      } catch (e) {
        say(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [persona, say, setSelected],
  );

  const startDraft = useCallback(
    (hs: ReaderHighlight[]) =>
      router.push(`/studio?new=1&ref=${hs.map((h) => h.id).join(",")}&persona=${encodeURIComponent(persona)}`),
    [router, persona],
  );

  async function openBulkMenu() {
    if (menu) {
      setMenu(null);
      return;
    }
    try {
      setMenu((await listInsertableDrafts(persona)).items);
    } catch (e) {
      say(errorText(e));
    }
  }

  const card = (h: ReaderHighlight, showDoc: boolean) => (
    <HighlightCard
      key={h.id}
      h={h}
      persona={persona}
      showDoc={showDoc}
      isCurrentDoc={h.doc_id === currentDocId}
      checked={selected.has(h.id)}
      onCheck={(on) => toggle([h.id], on)}
      onShow={() => onShow(h)}
      onCopy={() => void copy(citation(h), "Copied, with its source")}
      onRemove={() => onRemove(h.id)}
      onNote={(note) => void saveNote(h.id, note)}
      onInsert={(d) => void insert([h], d)}
      onStartDraft={() => startDraft([h])}
    />
  );

  const breakHours = session?.break_hours ?? 3;
  const page = variant === "page";

  return (
    <div className={page ? "flex flex-col" : "flex h-full min-h-0 flex-col"}>
      <div className={page ? "space-y-5" : "min-h-0 flex-1 space-y-5 overflow-y-auto p-3"}>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-muted">
            Select any text in a document to highlight it. Your highlights are private to you. They collect here from
            every document you read, so you can add them to a draft or start a new one from them.
          </p>
        ) : (
          <>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your highlights and notes"
              aria-label="Search your highlights and notes"
              className="w-full rounded-lg border border-border-strong bg-surface-sunken px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent"
            />

            <section aria-label="This session">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-text-muted">
                  This session{sessionItems.length ? ` (${sessionItems.length})` : ""}
                </h2>
                {sessionItems.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => toggle(sessionItems.map((h) => h.id), !allIn(sessionItems))}
                      className="ml-auto text-xs text-accent hover:underline"
                    >
                      {allIn(sessionItems) ? "Clear selection" : "Select all"}
                    </button>
                    <button
                      type="button"
                      onClick={onStartFresh}
                      title="Move this session's highlights to Earlier"
                      className="text-xs text-text-muted hover:text-text hover:underline"
                    >
                      Start fresh
                    </button>
                  </>
                )}
              </div>
              {sessionItems.length === 0 ? (
                <p className="text-[13px] text-text-muted">
                  {q
                    ? "Nothing in this session matches."
                    : `Highlights you make now collect here, from any document. A new session starts after a ${breakHours}-hour break, or when you start fresh.`}
                </p>
              ) : (
                <ul className="space-y-2.5">{sessionItems.map((h) => card(h, true))}</ul>
              )}
            </section>

            {earlierCount > 0 && (
              <section aria-label="Earlier">
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">Earlier ({earlierCount})</h2>
                <ul className="space-y-1.5">
                  {earlierGroups.map((g) => {
                    const expanded = !!q || open.has(g.docId);
                    return (
                      <li key={g.docId} className="rounded-lg border border-border bg-surface">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          <input
                            type="checkbox"
                            aria-label={`Select all highlights in ${g.title}`}
                            checked={allIn(g.items)}
                            onChange={(e) => toggle(g.items.map((h) => h.id), e.target.checked)}
                            className="h-4 w-4 shrink-0 accent-accent"
                          />
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() =>
                              setOpen((s) => {
                                const next = new Set(s);
                                if (next.has(g.docId)) next.delete(g.docId);
                                else next.add(g.docId);
                                return next;
                              })
                            }
                            className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                          >
                            <span className="mt-0.5 w-3 shrink-0 text-xs text-text-muted">{expanded ? "▾" : "▸"}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[13px] font-medium text-text">{g.title}</span>
                              <span className="block text-xs text-text-muted">
                                {g.items.length} highlight{g.items.length === 1 ? "" : "s"}
                                {g.last.created_at ? ` · ${formatDateIST(g.last.created_at)}` : ""}
                                {g.docId === currentDocId ? " · this document" : ""}
                              </span>
                            </span>
                          </button>
                        </div>
                        {expanded && <ul className="space-y-2 px-2 pb-2">{g.items.map((h) => card(h, false))}</ul>}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>

      {chosen.length > 0 && (
        <div
          className={`relative flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface-raised p-3 ${page ? "sticky bottom-0 mt-4 rounded-lg border shadow-lg" : ""}`}
        >
          <span className="text-[13px] text-text-muted">
            {chosen.length} selected
            {new Set(chosen.map((h) => h.doc_id)).size > 1 ? ` from ${new Set(chosen.map((h) => h.doc_id)).size} documents` : ""}
          </span>
          <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-text-muted hover:underline">
            Clear
          </button>
          <div className="ml-auto flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => void copy(citationsText(chosen), `Copied ${chosen.length} excerpts, with sources`)}
              className="rounded-lg border border-border-strong px-2.5 py-1.5 text-[13px] text-text hover:bg-surface-sunken"
            >
              Copy all
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void openBulkMenu()}
              className="rounded-lg border border-border-strong px-2.5 py-1.5 text-[13px] text-text hover:bg-surface-sunken disabled:opacity-50"
            >
              Add to a draft ▾
            </button>
            <button
              type="button"
              onClick={() => startDraft(chosen)}
              className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:bg-accent-hover"
            >
              New draft from these
            </button>
          </div>
          {menu && (
            <DraftMenu
              drafts={menu}
              className="absolute bottom-full right-3 mb-1 w-80"
              onPick={(d) => {
                setMenu(null);
                void insert(chosen, d);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DraftMenu({ drafts, className, onPick }: { drafts: InsertableDraft[]; className: string; onPick: (d: InsertableDraft) => void }) {
  return (
    <div className={`z-20 rounded-lg border border-border bg-surface-raised p-1 shadow-lg ${className}`}>
      {drafts.length === 0 ? (
        <p className="p-2 text-[13px] text-text-muted">You have no drafts you can edit right now.</p>
      ) : (
        drafts.slice(0, 10).map((d) => (
          <button
            key={d.id}
            type="button"
            className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-sunken"
            onClick={() => onPick(d)}
          >
            <span className="block truncate text-[13px] text-text">{d.title}</span>
            <span className="block text-xs text-text-muted">
              {[statusLabel(d.status), d.updated_at ? formatDateIST(d.updated_at) : ""].filter(Boolean).join(" · ")}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function HighlightCard({
  h,
  persona,
  showDoc,
  isCurrentDoc,
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
  showDoc: boolean;
  isCurrentDoc: boolean;
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

  useEffect(() => setNote(h.note ?? ""), [h.note]);

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
    <li id={`hl-card-${h.id}`} className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          aria-label="Select this highlight"
          checked={checked}
          disabled={saving}
          onChange={(e) => onCheck(e.target.checked)}
          className="mt-1 h-4 w-4 shrink-0 accent-accent"
        />
        <button type="button" onClick={onShow} className="min-w-0 flex-1 text-left" title={isCurrentDoc ? "Show in the document" : "Open at this passage"}>
          {showDoc && (
            <span className="mb-1 block truncate text-xs font-medium text-text-muted">
              {isCurrentDoc ? "This document" : (h.doc_title ?? h.doc_id)}
            </span>
          )}
          <p className="line-clamp-5 border-l-[3px] border-[#F2C200] pl-2 text-sm text-text">{h.quote}</p>
          <p className="mt-1 text-xs text-text-muted">
            Page {h.page}
            {saving ? " · saving…" : ""}
          </p>
        </button>
      </div>
      {editing ? (
        <div className="mt-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            autoFocus
            rows={2}
            placeholder="Why this matters, or how you'll use it"
            className="w-full resize-none rounded-lg border border-border-strong bg-surface-sunken px-2 py-1 text-[13px] text-text outline-none focus:border-accent"
          />
          <div className="mt-1 flex justify-end gap-2 text-[13px]">
            <button type="button" className="text-text-muted" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="font-medium text-accent"
              onClick={() => {
                onNote(note);
                setEditing(false);
              }}
            >
              Save note
            </button>
          </div>
        </div>
      ) : (
        h.note && <p className="mt-2 rounded bg-surface-sunken px-2 py-1 text-[13px] text-text-muted">{h.note}</p>
      )}
      {!saving && (
        <div className="relative mt-2 flex flex-wrap gap-1 text-[13px]">
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={onCopy}>
            Copy
          </button>
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={() => void openMenu()}>
            Insert into draft ▾
          </button>
          <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-sunken" onClick={onStartDraft}>
            New draft from this
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-text-muted hover:bg-surface-sunken" onClick={() => setEditing(true)}>
            {h.note ? "Edit note" : "Add note"}
          </button>
          <button type="button" className="rounded px-2 py-0.5 text-status-rejected-text hover:bg-surface-sunken" onClick={onRemove}>
            Remove
          </button>
          {menuError ? (
            <p className="absolute left-0 top-full z-20 mt-1 w-full rounded-lg border border-border bg-surface-raised p-2 text-[13px] text-status-rejected-text shadow-lg">
              {menuError}
            </p>
          ) : (
            menu && (
              <DraftMenu
                drafts={menu}
                className="absolute left-0 top-full mt-1 w-full"
                onPick={(d) => {
                  setMenu(null);
                  onInsert(d);
                }}
              />
            )
          )}
        </div>
      )}
    </li>
  );
}
