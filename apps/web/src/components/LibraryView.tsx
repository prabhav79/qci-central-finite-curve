"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  LIBRARY_FIELDS,
  type LibraryField,
  type LibraryResponse,
  type LibraryResult,
  type PersonaKey,
  errorText,
  isPersonasMode,
  libraryDocuments,
} from "@/lib/cfcApi";
import { passagePhrase, readerHref } from "@/lib/reader";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { OutcomeBadge, PersonaPicker, docDate, rupees } from "./DocumentReader";

const FIELD_LABELS: Record<LibraryField, string> = {
  outcome: "Outcome",
  work_type: "Type of work",
  sector: "Sector",
  client: "Client",
  doc_type: "Document",
  year: "Year",
  state: "State",
};

type Filters = Partial<Record<LibraryField, string[]>>;
type View = "documents" | "coverage" | "engagements";

function queryWords(q: string): string[] {
  return (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2);
}

/** The snippet with the query's words marked. */
function Marked({ text, q }: { text: string; q: string }) {
  const words = queryWords(q);
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "giu");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-[#FFE066] px-0.5 text-[#1a1a1a]">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function LibraryView() {
  const { me } = useCurrentUser();
  const router = useRouter();
  const params = useSearchParams();
  const [persona, setPersona] = useState<PersonaKey>("arpit");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [submitted, setSubmitted] = useState(params.get("q") ?? "");
  const [filters, setFilters] = useState<Filters>({});
  const [sort, setSort] = useState("best");
  const [wonFirst, setWonFirst] = useState(true);
  const [view, setView] = useState<View>("documents");
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    libraryDocuments(persona, { q: submitted, filters, sort, wonFirst })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError(null);
      })
      .catch((e) => !cancelled && setError(errorText(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [persona, submitted, filters, sort, wonFirst]);

  const search = useCallback(() => {
    setSubmitted(query.trim());
    router.replace(query.trim() ? `/studio/library?q=${encodeURIComponent(query.trim())}` : "/studio/library");
  }, [query, router]);

  const toggle = (field: LibraryField, value: string) =>
    setFilters((f) => {
      const current = f[field] ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...f, [field]: next };
    });

  const chips = LIBRARY_FIELDS.flatMap((field) =>
    (filters[field] ?? []).map((value) => ({
      field,
      value,
      label: data?.facets[field]?.find((o) => o.value === value)?.label ?? value,
    })),
  );

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight">Library</h1>
          <p className="mt-1 text-sm text-text-muted">
            Everything QCI has written that you can see, with the work we won first. Open any document to read and
            highlight it.
          </p>
        </div>
        {isPersonasMode(me) && (
          <div className="ml-auto">
            <PersonaPicker persona={persona} setPersona={setPersona} />
          </div>
        )}
      </header>

      <div className="flex flex-wrap gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search by topic, scheme, client or phrase, e.g. grievance PMU staffing"
          aria-label="Search the library"
          className="min-w-[260px] flex-1 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={search}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
        >
          Search
        </button>
        <div className="flex rounded-lg border border-border-strong p-0.5 text-[13px]" role="tablist" aria-label="View">
          {(
            [
              ["documents", "Documents"],
              ["coverage", "Coverage"],
              ["engagements", "Engagements"],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 font-medium ${view === v ? "bg-accent/10 text-accent" : "text-text-muted hover:text-text"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-6 md:flex-row">
        <aside className="w-full shrink-0 space-y-4 md:w-60" aria-label="Filters">
          {data &&
            LIBRARY_FIELDS.map((field) => (
              <FacetGroup
                key={field}
                label={FIELD_LABELS[field]}
                options={data.facets[field] ?? []}
                chosen={filters[field] ?? []}
                onToggle={(v) => toggle(field, v)}
              />
            ))}
        </aside>

        <section className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-text-muted">
              {loading ? "Searching…" : data ? `${data.total} document${data.total === 1 ? "" : "s"}` : ""}
              {submitted && !loading ? ` for “${submitted}”` : ""}
            </span>
            {chips.map((c) => (
              <button
                key={`${c.field}:${c.value}`}
                type="button"
                onClick={() => toggle(c.field, c.value)}
                className="rounded-full border border-border-strong px-2 py-0.5 text-text hover:bg-surface-sunken"
                aria-label={`Remove filter ${c.label}`}
              >
                {c.label} ×
              </button>
            ))}
            {(chips.length > 0 || submitted) && (
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => {
                  setFilters({});
                  setQuery("");
                  setSubmitted("");
                  router.replace("/studio/library");
                }}
              >
                Clear all
              </button>
            )}
            {view === "documents" && (
              <div className="ml-auto flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-text-muted">
                  <input
                    type="checkbox"
                    checked={wonFirst}
                    onChange={(e) => setWonFirst(e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                  Won work first
                </label>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  aria-label="Sort"
                  className="rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-text"
                >
                  <option value="best">{submitted ? "Best match" : "Newest"}</option>
                  {submitted && <option value="newest">Newest</option>}
                  <option value="value">Largest value</option>
                </select>
              </div>
            )}
          </div>

          {error ? (
            <p className="rounded-lg border border-border bg-surface-raised p-4 text-sm text-text">{error}</p>
          ) : !data ? null : view === "documents" ? (
            <ResultList items={data.items} q={submitted} />
          ) : view === "coverage" ? (
            <CoverageGrid
              grid={data.grid}
              onPick={(sector, workType) => {
                setFilters((f) => ({ ...f, sector: [sector], work_type: [workType] }));
                setView("documents");
              }}
            />
          ) : (
            <Engagements engagements={data.engagements} />
          )}
        </section>
      </div>
    </div>
  );
}

function FacetGroup({
  label,
  options,
  chosen,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string; count: number }[];
  chosen: string[];
  onToggle: (value: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (!options.length) return null;
  const shown = all ? options : options.slice(0, 6);
  return (
    <fieldset>
      <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">{label}</legend>
      <ul className="space-y-0.5">
        {shown.map((o) => (
          <li key={o.value}>
            <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-surface-sunken">
              <input
                type="checkbox"
                checked={chosen.includes(o.value)}
                onChange={() => onToggle(o.value)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
              />
              <span className={`min-w-0 flex-1 ${o.count === 0 ? "text-text-muted" : "text-text"}`}>{o.label}</span>
              <span className="shrink-0 tabular-nums text-xs text-text-muted">{o.count}</span>
            </label>
          </li>
        ))}
      </ul>
      {options.length > 6 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-0.5 px-1 text-xs text-accent hover:underline">
          {all ? "Show fewer" : `Show all ${options.length}`}
        </button>
      )}
    </fieldset>
  );
}

function ResultList({ items, q }: { items: LibraryResult[]; q: string }) {
  if (!items.length) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-muted">
        Nothing matches. Try fewer words, or clear a filter.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {items.map((d) => {
        const meta = [d.client, d.work_type, d.doc_type, docDate(d.date), rupees(d.value_inr)].filter(Boolean);
        const phrase = d.snippet ? passagePhrase(d.snippet, queryWords(q)) : "";
        return (
          <li key={d.doc_id} className="rounded-lg border border-border bg-surface-raised p-4">
            <div className="flex items-start gap-2">
              <Link href={readerHref(d.doc_id)} className="min-w-0 flex-1 text-[15px] font-medium text-text hover:text-accent">
                {d.title}
              </Link>
              <OutcomeBadge doc={d} />
            </div>
            <p className="mt-0.5 text-xs text-text-muted">{meta.join(" · ")}</p>
            {d.snippet && (
              <p className="mt-2 text-[13px] leading-relaxed text-text">
                <Marked text={d.snippet} q={q} />
              </p>
            )}
            <div className="mt-2 flex gap-3 text-[13px]">
              <Link href={readerHref(d.doc_id)} className="font-medium text-accent hover:underline">
                Open in Reader
              </Link>
              {phrase && (
                <Link href={readerHref(d.doc_id, phrase)} className="text-accent hover:underline">
                  Go to this passage
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CoverageGrid({
  grid,
  onPick,
}: {
  grid: LibraryResponse["grid"];
  onPick: (sector: string, workType: string) => void;
}) {
  if (!grid.rows.length) {
    return <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-muted">Nothing to show.</p>;
  }
  const max = Math.max(1, ...grid.rows.flatMap((r) => grid.cols.map((c) => grid.cells[r]?.[c]?.count ?? 0)));
  return (
    <div>
      <p className="mb-3 text-[13px] text-text-muted">
        How much past work QCI has in each sector, by type of work. A stronger colour means more documents to learn
        from; empty cells are gaps. Select a cell to see its documents.
      </p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-surface-raised">
              <th className="sticky left-0 bg-surface-raised p-2 text-left font-medium text-text-muted">Sector</th>
              {grid.cols.map((c) => (
                <th key={c} className="min-w-[96px] p-2 text-left align-bottom font-medium text-text-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r) => (
              <tr key={r} className="border-t border-border">
                <th scope="row" className="sticky left-0 min-w-[180px] bg-surface-raised p-2 text-left font-normal text-text">
                  {r}
                </th>
                {grid.cols.map((c) => {
                  const cell = grid.cells[r]?.[c];
                  if (!cell) return <td key={c} className="p-1" aria-label="None" />;
                  const pct = Math.round(15 + (cell.count / max) * 70);
                  return (
                    <td key={c} className="p-1">
                      <button
                        type="button"
                        onClick={() => onPick(r, c)}
                        title={`${cell.count} document${cell.count === 1 ? "" : "s"}, ${cell.won} won`}
                        style={{ background: `color-mix(in srgb, var(--color-accent) ${pct}%, transparent)` }}
                        className={`w-full rounded px-2 py-1.5 text-left ${pct > 50 ? "text-white" : "text-text"}`}
                      >
                        <span className="font-medium tabular-nums">{cell.count}</span>
                        {cell.won > 0 && <span className="ml-1 text-xs opacity-80">· {cell.won} won</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** "CPGRAMS PMU – 3rd Work Order (Feb 2024)" reads as "3rd Work Order (Feb 2024)" under its engagement. */
function withinEngagement(title: string, engagement: string): string {
  if (!title.startsWith(engagement)) return title;
  const rest = title.slice(engagement.length).replace(/^\s*[–—-]\s*/, "");
  return rest || title;
}

function Engagements({ engagements }: { engagements: LibraryResponse["engagements"] }) {
  if (!engagements.length) {
    return (
      <p className="rounded-lg border border-dashed border-border p-6 text-sm text-text-muted">
        None of these documents belong to a longer engagement.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-text-muted">
        Work that ran over several documents (a proposal, then work orders and renewals), oldest first.
      </p>
      {engagements.map((e) => (
        <section key={e.engagement} className="rounded-lg border border-border bg-surface-raised p-4">
          <h2 className="text-[15px] font-medium text-text">
            {e.engagement}
            <span className="ml-2 text-xs font-normal text-text-muted">
              {[e.client, `${e.documents.length} documents`].filter(Boolean).join(" · ")}
            </span>
          </h2>
          <ol className="mt-3 flex gap-0 overflow-x-auto pb-1">
            {e.documents.map((d, i) => (
              <li key={d.doc_id} className="relative min-w-[150px] max-w-[190px] flex-1">
                <div className="flex items-center">
                  <span
                    className={`h-3 w-3 shrink-0 rounded-full border-2 ${d.outcome === "successful" ? "border-status-approved-text bg-status-approved-surface" : "border-border-strong bg-surface"}`}
                  />
                  {i < e.documents.length - 1 && <span className="h-px flex-1 bg-border-strong" />}
                </div>
                <Link href={readerHref(d.doc_id)} className="mr-2 mt-1.5 block rounded p-1 hover:bg-surface-sunken">
                  <span className="block text-xs text-text-muted">
                    {[docDate(d.date), d.doc_type].filter(Boolean).join(" · ")}
                  </span>
                  <span className="line-clamp-2 text-[13px] text-text">{withinEngagement(d.title, e.engagement)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
