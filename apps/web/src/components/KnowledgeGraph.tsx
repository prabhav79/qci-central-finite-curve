"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PERSONAS,
  type GraphNode,
  type GraphPreviewResponse,
  type PersonaKey,
  getGraphChildren,
  getGraphPreview,
} from "@/lib/cfcApi";

// react-force-graph-2d touches window/canvas at import time, so it must load
// client-side only (Next.js App Router server components can't see it).
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-xs text-text-muted">
      Loading graph engine…
    </div>
  ),
});

type NodeType = "root" | GraphNode["type"];

type GNode = {
  id: string;
  label: string;
  type: NodeType;
  count: number | null;
  doc_id: string | null;
  kind: string | null;
  weight: number | null;
  // react-force-graph mutates x/y/vx/vy on this same object as the
  // simulation runs — we never clone a node once it's been added.
  x?: number;
  y?: number;
};

type GLink = { source: string; target: string };

const ROOT_ID = "__root__";

// Canvas can't consume CSS variables directly, so these mirror the design
// tokens' literal values (globals.css) for each theme rather than reusing
// the old ad-hoc amber/cyan/violet set.
const NODE_COLOR_LIGHT: Record<NodeType, string> = {
  root: "#c9c2ae", // --color-border-strong
  ministry: "#0079af", // --color-accent
  domain: "#d9691e", // --color-highlight
  document: "#6b2e3a", // --color-agent
};
const NODE_COLOR_DARK: Record<NodeType, string> = {
  root: "#333c48",
  ministry: "#1b9bd8",
  domain: "#e8873f",
  document: "#b5566a",
};

const NODE_RADIUS: Record<NodeType, number> = {
  root: 7,
  ministry: 6,
  domain: 5,
  document: 4,
};

function toGNode(n: GraphNode): GNode {
  return {
    id: n.id,
    label: n.label,
    type: n.type,
    count: n.count,
    doc_id: n.doc_id,
    kind: n.kind,
    weight: n.weight,
  };
}

function rootNode(): GNode {
  return {
    id: ROOT_ID,
    label: "Corpus",
    type: "root",
    count: null,
    doc_id: null,
    kind: null,
    weight: null,
  };
}

type PreviewState =
  | { status: "idle" }
  | { status: "loading"; docId: string }
  | { status: "error"; docId: string; message: string }
  | { status: "ready"; docId: string; data: GraphPreviewResponse };

/**
 * Collapsible/expandable knowledge-graph view over /corpus/graph/*.
 * Root = ministries; click expands a node's children lazily (ministry ->
 * domains -> documents -> related-document edges), a second click on an
 * already-fetched node toggles it collapsed again. Clicking a document node
 * additionally opens a read-only preview panel via getGraphPreview.
 */
export function KnowledgeGraph() {
  const [persona, setPersona] = useState<PersonaKey>("arpit");
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const nodeColor = isDark ? NODE_COLOR_DARK : NODE_COLOR_LIGHT;
  const canvasBg = isDark ? "#0b0e12" : "#f0ede4"; // --color-surface-sunken
  const canvasText = isDark ? "#f2f0ea" : "#211e19"; // --color-text
  const canvasLink = isDark ? "rgba(242,240,234,0.25)" : "rgba(33,30,25,0.2)";

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });

  // All nodes/edges ever fetched, keyed by id — kept in refs so node object
  // identity survives across graphData recomputations (needed for the force
  // simulation to keep existing nodes' x/y instead of jumping every render).
  const allNodesRef = useRef<Map<string, GNode>>(new Map([[ROOT_ID, rootNode()]]));
  const childrenMapRef = useRef<Map<string, string[]>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0); // bump to recompute graphData after ref mutation
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });

  const setLoading = useCallback((id: string, on: boolean) => {
    setLoadingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const loadRoot = useCallback(async (p: PersonaKey) => {
    allNodesRef.current = new Map([[ROOT_ID, rootNode()]]);
    childrenMapRef.current = new Map();
    setCollapsed(new Set());
    setPreview({ status: "idle" });
    setError(null);
    setLoading(ROOT_ID, true);
    try {
      const res = await getGraphChildren(p);
      const nodes = res.nodes.map(toGNode);
      for (const n of nodes) allNodesRef.current.set(n.id, n);
      childrenMapRef.current.set(
        ROOT_ID,
        nodes.map((n) => n.id),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(ROOT_ID, false);
      setVersion((v) => v + 1);
    }
  }, [setLoading]);

  useEffect(() => {
    void loadRoot(persona);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const openPreview = useCallback(
    async (docId: string) => {
      setPreview({ status: "loading", docId });
      try {
        const data = await getGraphPreview(persona, docId);
        setPreview({ status: "ready", docId, data });
      } catch (e) {
        setPreview({
          status: "error",
          docId,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [persona],
  );

  const expand = useCallback(
    async (node: GNode) => {
      if (childrenMapRef.current.has(node.id)) {
        // Already fetched once — second click just toggles the subtree.
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(node.id)) next.delete(node.id);
          else next.add(node.id);
          return next;
        });
        return;
      }
      setLoading(node.id, true);
      setError(null);
      try {
        // Node ids already are the opaque parent-id scheme the API expects
        // ("ministry:x", "domain:x::y", "doc:z"), so expansion is uniform.
        const res = await getGraphChildren(persona, node.id);
        const nodes = res.nodes.map(toGNode);
        for (const n of nodes) {
          if (!allNodesRef.current.has(n.id)) allNodesRef.current.set(n.id, n);
        }
        childrenMapRef.current.set(
          node.id,
          nodes.map((n) => n.id),
        );
      } catch (e) {
        setError(`Could not expand "${node.label}": ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setLoading(node.id, false);
        setVersion((v) => v + 1);
      }
    },
    [persona, setLoading],
  );

  const onNodeClick = useCallback(
    (node: GNode) => {
      if (node.type === "document" && node.doc_id) {
        void openPreview(node.doc_id);
      }
      void expand(node);
    },
    [expand, openPreview],
  );

  const graphData = useMemo(() => {
    const visible = new Set<string>();
    const stack = [ROOT_ID];
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined || visible.has(id)) continue;
      visible.add(id);
      if (collapsed.has(id)) continue;
      for (const childId of childrenMapRef.current.get(id) ?? []) stack.push(childId);
    }
    const nodes: GNode[] = [];
    visible.forEach((id) => {
      const n = allNodesRef.current.get(id);
      if (n) nodes.push(n);
    });
    const links: GLink[] = [];
    visible.forEach((id) => {
      if (collapsed.has(id)) return;
      for (const childId of childrenMapRef.current.get(id) ?? []) {
        if (visible.has(childId)) links.push({ source: id, target: childId });
      }
    });
    return { nodes, links };
    // `version` intentionally triggers recompute after mutating the refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, version]);

  const isEmpty = !loadingIds.has(ROOT_ID) && graphData.nodes.length <= 1;

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col gap-3 p-4 text-text">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">Knowledge graph</h1>
        <p className="max-w-xl text-xs text-text-muted">
          Ministries → domains → documents → related documents. Click a node to expand it;
          click again to collapse. Silo-scoped to your division; SG / Admin see all boards.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadRoot(persona)}
            className="rounded-lg border border-border-strong px-3 py-1 text-xs text-text transition-colors hover:bg-surface-sunken"
          >
            Reset
          </button>
          <label className="text-xs text-text-muted">
            Persona
            <select
              className="ml-2 rounded-lg border border-border-strong bg-surface-raised px-2 py-1 text-sm text-text"
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
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-[10px] text-text-muted">
        {(["ministry", "domain", "document"] as const).map((t) => (
          <span key={t} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: nodeColor[t] }}
            />
            <span className="uppercase tracking-wide">{t}</span>
          </span>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-xs text-status-rejected-text">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        <section
          ref={containerRef}
          className="relative min-h-[420px] overflow-hidden rounded-xl border border-border bg-surface-raised"
        >
          {dims.width > 0 && dims.height > 0 && !isEmpty && (
            <ForceGraph2D
              // Remount on theme change: the graph's canvas only repaints on
              // its own simulation ticks, which have long since stopped
              // (cooldownTicks) by the time someone toggles the app theme —
              // without this the canvas would keep showing the old theme's
              // colors until the next interaction.
              key={resolvedTheme}
              graphData={graphData}
              width={dims.width}
              height={dims.height}
              backgroundColor={canvasBg}
              nodeId="id"
              nodeLabel={(n: unknown) => {
                const node = n as GNode;
                const parts = [node.label];
                if (node.count != null) parts.push(`${node.count} doc${node.count === 1 ? "" : "s"}`);
                if (node.weight != null) parts.push(`similarity ${node.weight.toFixed(2)}`);
                return parts.join(" · ");
              }}
              linkColor={() => canvasLink}
              linkWidth={1}
              onNodeClick={(n: unknown) => onNodeClick(n as GNode)}
              nodeCanvasObjectMode={() => "replace"}
              nodeCanvasObject={(n: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const node = n as GNode;
                if (node.x == null || node.y == null) return;
                const r = NODE_RADIUS[node.type];
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = nodeColor[node.type];
                ctx.fill();
                if (loadingIds.has(node.id)) {
                  ctx.lineWidth = 1.5 / globalScale;
                  ctx.strokeStyle = canvasText;
                  ctx.stroke();
                }
                const fontSize = Math.max(10 / globalScale, 2);
                ctx.font = `${fontSize}px sans-serif`;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillStyle = canvasText;
                ctx.fillText(node.label, node.x + r + 2, node.y);
              }}
              nodePointerAreaPaint={(n: unknown, color: string, ctx: CanvasRenderingContext2D) => {
                const node = n as GNode;
                if (node.x == null || node.y == null) return;
                const r = NODE_RADIUS[node.type];
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
                ctx.fill();
              }}
              cooldownTicks={100}
            />
          )}

          {loadingIds.has(ROOT_ID) && (
            <div className="absolute bottom-2 left-2 rounded-lg border border-border bg-surface-raised/90 px-2 py-1 text-[10px] text-text-muted">
              Loading graph…
            </div>
          )}
          {isEmpty && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-xs text-text-muted">
              {error
                ? "Graph unavailable — see error above."
                : "No ministries visible for this persona yet."}
            </div>
          )}
        </section>

        <aside className="space-y-2 overflow-auto rounded-xl border border-border bg-surface-raised p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-text-muted">Preview</div>
          {preview.status === "idle" && (
            <p className="text-[11px] text-text-muted">Click a document node to preview it.</p>
          )}
          {preview.status === "loading" && (
            <p className="text-[11px] text-text-muted">Loading preview…</p>
          )}
          {preview.status === "error" && (
            <p className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-[11px] text-status-rejected-text">
              {preview.message}
            </p>
          )}
          {preview.status === "ready" && preview.data.kind === "corpus_document" && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-text">{preview.data.title}</div>
              <div className="text-[11px] text-text-muted">
                {preview.data.ministry}
                {preview.data.date ? ` · ${preview.data.date}` : ""}
              </div>
              <div className="flex flex-wrap gap-1">
                {preview.data.domains.map((d) => (
                  <span
                    key={d}
                    className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] text-text-muted"
                  >
                    {d}
                  </span>
                ))}
              </div>
              <div className="inline-block rounded border border-border bg-surface-sunken px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                {preview.data.source_kind}
              </div>
              <div className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-sunken p-2 text-[11px] text-text">
                {preview.data.text}
              </div>
            </div>
          )}
          {preview.status === "ready" && preview.data.kind === "draft" && (
            <div className="space-y-2">
              <p className="text-[11px] text-text-muted">
                This corpus document is linked to a final-approved draft.
              </p>
              <Link
                href={`/studio?open=${encodeURIComponent(preview.data.draft_id)}&persona=${encodeURIComponent(persona)}`}
                className="inline-block rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Open in editor
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
