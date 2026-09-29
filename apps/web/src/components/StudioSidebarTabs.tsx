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
      <div className="mb-3 flex gap-1 rounded-lg bg-surface-sunken p-1 text-xs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`min-w-0 flex-1 rounded-md px-1.5 py-2 font-medium transition-colors ${
              active === t.key
                ? "bg-accent text-white shadow-sm"
                : "text-text-muted hover:bg-surface-raised hover:text-text"
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
