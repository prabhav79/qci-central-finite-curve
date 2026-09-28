"use client";

import { useEffect, useState, type ReactNode } from "react";

type TabKey = "draft" | "generate" | "research" | "corpus" | "comments";

const TABS: { key: TabKey; label: string }[] = [
  { key: "draft", label: "Draft" },
  { key: "generate", label: "Generate" },
  { key: "research", label: "Research" },
  { key: "corpus", label: "Corpus" },
  { key: "comments", label: "Comments" },
];

/**
 * Collapses the Studio sidebar's 9 previously-always-visible sections into 5
 * tabs, one purposeful panel at a time — see plan item 2b. Purely structural:
 * no visual/design changes, each panel keeps its own existing internal
 * scroll caps unchanged. Reuses the filter-button visual pattern already
 * established by ThreadsPanel's OPEN/RESOLVED/ALL group for consistency.
 */
export function StudioSidebarTabs({
  draft,
  generate,
  research,
  corpus,
  comments,
  activateGenerateSignal,
}: {
  draft: ReactNode;
  generate: ReactNode;
  research: ReactNode;
  corpus: ReactNode;
  comments: ReactNode;
  /** Bump this (e.g. a counter) to force-switch to the Generate tab — used
   * when a generation run auto-starts (e.g. "Create & generate" in
   * NewDraftModal) so the user actually sees it happen instead of landing
   * on Draft while it runs unseen behind a hidden tab. 0/undefined never
   * triggers, so a fresh mount doesn't jump tabs on its own. */
  activateGenerateSignal?: number;
}) {
  const [active, setActive] = useState<TabKey>("draft");
  const content: Record<TabKey, ReactNode> = { draft, generate, research, corpus, comments };

  useEffect(() => {
    if (activateGenerateSignal) setActive("generate");
  }, [activateGenerateSignal]);

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`rounded px-2 py-1 ${
              active === t.key ? "bg-zinc-700 text-zinc-100" : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* All five stay mounted (just hidden) rather than conditionally
       * rendering only the active one — switching away from "Generate"
       * mid-stream must not unmount AgentPanel and lose its in-flight
       * progress; CSS visibility is cheap for content this size. */}
      {TABS.map((t) => (
        <div key={t.key} className={active === t.key ? "" : "hidden"}>
          {content[t.key]}
        </div>
      ))}
    </div>
  );
}
