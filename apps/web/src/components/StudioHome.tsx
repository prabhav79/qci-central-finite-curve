"use client";

import type { DraftRecord, DraftSession, InboxItem } from "@/lib/cfcApi";
import { documentTitle, isEmptyUntitled, personName } from "@/lib/copy";
import { formatAgeIST, formatDateTimeIST } from "@/lib/dates";
import { StatusPill } from "@/components/StatusPill";

type DraftItem = { draft: DraftRecord; session: DraftSession };

function Row({
  title,
  status,
  meta,
  onOpen,
  disabled,
}: {
  title: string;
  status: string;
  meta: string;
  onOpen: () => void;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus-ring disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text">{title}</span>
          {meta && <span className="mt-0.5 block text-[13px] text-text-muted">{meta}</span>}
        </span>
        <StatusPill status={status} />
      </button>
    </li>
  );
}

/** What the Studio shows when no document is open: start something new,
 * act on anything waiting, or pick up a recent document. */
export function StudioHome({
  name,
  drafts,
  inbox,
  loading,
  disabled,
  onNew,
  onOpen,
}: {
  name?: string;
  drafts: DraftItem[];
  inbox: InboxItem[];
  loading: boolean;
  disabled?: boolean;
  onNew: () => void;
  onOpen: (draftId: string) => void;
}) {
  const recent = drafts.filter((d) => !isEmptyUntitled(d.draft)).slice(0, 12);
  const waiting = inbox.filter((i) => i.session.can_decide_l1 || i.session.can_decide_l2);
  const firstName = name?.split(/\s+/)[0];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-2 py-6 sm:py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl font-medium tracking-tight text-text">
              {firstName ? `Welcome, ${firstName}` : "Documents"}
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              Create a new document or open a recent one.
            </p>
          </div>
          <button
            type="button"
            onClick={onNew}
            disabled={disabled}
            className="rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            Start a new document
          </button>
        </div>

        {waiting.length > 0 && (
          <section aria-labelledby="home-waiting">
            <h2 id="home-waiting" className="mb-2 text-sm font-semibold text-text">
              Waiting for your approval
            </h2>
            <ul className="space-y-2">
              {waiting.map((item) => (
                <Row
                  key={item.draft.id}
                  title={documentTitle(item.draft)}
                  status={item.draft.status}
                  meta={[
                    `by ${personName(item.maker_name, item.draft.maker_employee_id)}`,
                    formatAgeIST(item.draft.updated_at),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  onOpen={() => onOpen(item.draft.id)}
                  disabled={disabled}
                />
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="home-recent">
          <h2 id="home-recent" className="mb-2 text-sm font-semibold text-text">
            Recent documents
          </h2>
          {loading && recent.length === 0 ? (
            <ul className="space-y-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <li key={i} className="h-[62px] animate-pulse rounded-lg border border-border bg-surface-raised" />
              ))}
            </ul>
          ) : recent.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-text-muted">
              No documents yet. Start a new one to begin.
            </p>
          ) : (
            <ul className="space-y-2">
              {recent.map((item) => (
                <Row
                  key={item.draft.id}
                  title={documentTitle(item.draft)}
                  status={item.draft.status}
                  meta={item.draft.updated_at ? `Updated ${formatDateTimeIST(item.draft.updated_at)}` : ""}
                  onOpen={() => onOpen(item.draft.id)}
                  disabled={disabled}
                />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
