"use client";

import { useEffect, useState, type ReactNode } from "react";

type TabKey = "document" | "generate" | "research" | "comments" | "corpus";

const LABELS: Record<TabKey, string> = {
  document: "Document",
  generate: "Generate",
  research: "Research",
  comments: "Comments",
  corpus: "Corpus",
};

/**
 * The Studio sidebar: one purposeful panel at a time. The tab bar stays put
 * and only the active panel scrolls. Corpus is passed only for admins.
 */
export function StudioSidebarTabs({
  overview,
  generate,
  research,
  comments,
  corpus,
  activateGenerateSignal,
}: {
  overview: ReactNode;
  generate: ReactNode;
  research: ReactNode;
  comments: ReactNode;
  corpus?: ReactNode;
  /** Bump (e.g. a counter) to switch to the Generate tab when a generation
   * run starts, so it never runs unseen behind another tab. 0 never fires. */
  activateGenerateSignal?: number;
}) {
  const [active, setActive] = useState<TabKey>("document");
  const content: Partial<Record<TabKey, ReactNode>> = { document: overview, generate, research, comments, corpus };
  const tabs = (Object.keys(LABELS) as TabKey[]).filter((k) => k !== "corpus" || corpus != null);

  useEffect(() => {
    if (activateGenerateSignal) setActive("generate");
  }, [activateGenerateSignal]);

  useEffect(() => {
    if (active === "corpus" && corpus == null) setActive("document");
  }, [active, corpus]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Document tools"
        className="m-2 mb-0 flex shrink-0 gap-1 overflow-x-auto rounded-lg bg-surface-sunken p-1 text-[13px]"
      >
        {tabs.map((key) => (
          <button
            key={key}
            id={`studio-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={active === key}
            aria-controls={`studio-panel-${key}`}
            onClick={() => setActive(key)}
            className={`flex-1 whitespace-nowrap rounded-md px-2 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-focus-ring ${
              active === key
                ? "bg-accent text-white shadow-sm"
                : "text-text-muted hover:bg-surface-raised hover:text-text"
            }`}
          >
            {LABELS[key]}
          </button>
        ))}
      </div>
      {/* Every panel stays mounted (just hidden) so switching away from
       * Generate mid-run never unmounts it and loses its progress. */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tabs.map((key) => (
          <div
            key={key}
            id={`studio-panel-${key}`}
            role="tabpanel"
            aria-labelledby={`studio-tab-${key}`}
            hidden={active !== key}
          >
            {content[key]}
          </div>
        ))}
      </div>
    </div>
  );
}
