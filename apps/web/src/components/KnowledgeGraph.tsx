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
  errorText,
  getGraphChildren,
  getGraphPreview,
  isPersonasMode,
} from "@/lib/cfcApi";
import { formatDateIST } from "@/lib/dates";
import { useCurrentUser } from "@/lib/useCurrentUser";

// react-force-graph-2d touches window/canvas at import time, so it must load
// client-side only (Next.js App Router server components can't see it).
// next/dynamic doesn't forward refs, so the graph's methods (zoomToFit,
// d3Force) are reached through an ordinary `graphRef` prop instead.
type GraphHandle = {
  zoomToFit: (ms?: number, padding?: number) => void;
  d3Force: (name: string) => { strength?: (v: number) => unknown; distance?: (v: number) => unknown } | undefined;
};
const ForceGraph2D = dynamic(
  () =>
    import("react-force-graph-2d").then((mod) => {
      const Graph = mod.default as unknown as React.ComponentType<Record<string, unknown>>;
      function GraphWithRef({ graphRef, ...props }: Record<string, unknown> & { graphRef?: React.Ref<GraphHandle> }) {
        return <Graph {...props} ref={graphRef} />;
      }
      return GraphWithRef;
    }),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-[13px] text-text-muted">
        Loading…
      </div>
    ),
  },
);

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

type Palette = { node: Record<NodeType, string>; bg: string; text: string; link: string };

// Canvas can't consume CSS variables, so the design tokens are read once the
// page has mounted (and again on theme change). Reading them during render
// would differ between server and client and break hydration.
function readPalette(): Palette {
  const css = window.getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    node: {
      root: v("--color-border-strong", "gray"),
      ministry: v("--color-accent", "steelblue"),
      domain: v("--color-highlight", "darkorange"),
      document: v("--color-agent", "brown"),
    },
    bg: v("--color-surface-sunken", "whitesmoke"),
    text: v("--color-text", "black"),
    link: v("--color-border-strong", "gray"),
  };
}

const LEGEND: { type: Exclude<NodeType, "root">; label: string; dot: string }[] = [
  { type: "ministry", label: "Ministry", dot: "bg-accent" },
  { type: "domain", label: "Topic", dot: "bg-highlight" },
  { type: "document", label: "Document", dot: "bg-agent" },
];

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
    label: "QCI Knowledge Base",
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
  const { me, error: meError } = useCurrentUser();
  const { resolvedTheme } = useTheme();
  const [palette, setPalette] = useState<Palette | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setPalette(readPalette()));
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<GraphHandle | null>(null);
  // Stronger repulsion and longer links than the library default, so the
  // ministry labels around the root don't pile on top of each other.
  const attachGraph = useCallback((g: GraphHandle | null) => {
    graphRef.current = g;
    g?.d3Force("charge")?.strength?.(-260);
    g?.d3Force("link")?.distance?.(70);
  }, []);
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
      setError(errorText(e));
    } finally {
      setLoading(ROOT_ID, false);
      setVersion((v) => v + 1);
    }
  }, [setLoading]);

  useEffect(() => {
    if (me) void loadRoot(persona);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, persona]);

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
          message: errorText(e),
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
        setError(`Couldn't open "${node.label}". ${errorText(e)}`);
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
    <div className="flex h-full min-h-[560px] flex-col gap-3 p-4 text-text">
      <header className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight">Knowledge graph</h1>
          <p className="mt-1 max-w-xl text-sm text-text-muted">
            Explore QCI&apos;s past work by ministry and topic. Click a circle to open it; click it
            again to close it.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadRoot(persona)}
            className="rounded-lg border border-border-strong px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-surface-sunken"
          >
            Reset
          </button>
          {isPersonasMode(me) && (
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
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-4 text-[13px] text-text-muted">
        {LEGEND.map((l) => (
          <span key={l.type} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${l.dot}`} aria-hidden />
            {l.label}
          </span>
        ))}
      </div>

      {(error || meError) && (
        <div className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-[13px] text-status-rejected-text">
          {error ?? meError}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_320px]">
        <section
          ref={containerRef}
          className="relative min-h-[420px] overflow-hidden rounded-xl border border-border bg-surface-raised"
        >
          {palette && dims.width > 0 && dims.height > 0 && !isEmpty && (
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
              backgroundColor={palette.bg}
              nodeId="id"
              nodeLabel={(n: unknown) => {
                const node = n as GNode;
                const parts = [node.label];
                if (node.count != null) parts.push(`${node.count} doc${node.count === 1 ? "" : "s"}`);
                if (node.weight != null) parts.push(node.weight >= 0.75 ? "Closely related" : "Related");
                return parts.join(" · ");
              }}
              linkColor={() => palette.link}
              linkWidth={1}
              onNodeClick={(n: unknown) => onNodeClick(n as GNode)}
              nodeCanvasObjectMode={() => "replace"}
              nodeCanvasObject={(n: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
                const node = n as GNode;
                if (node.x == null || node.y == null) return;
                const r = NODE_RADIUS[node.type];
                ctx.beginPath();
                ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = palette.node[node.type];
                ctx.fill();
                if (loadingIds.has(node.id)) {
                  ctx.lineWidth = 1.5 / globalScale;
                  ctx.strokeStyle = palette.text;
                  ctx.stroke();
                }
                const fontSize = Math.max(12 / globalScale, 2);
                ctx.font = `${fontSize}px system-ui, sans-serif`;
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillStyle = palette.text;
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
              graphRef={attachGraph}
              // Spread nodes so labels don't pile up, then frame the whole
              // graph once it settles (and again after each expand).
              onEngineStop={() => graphRef.current?.zoomToFit(500, 48)}
            />
          )}

          {loadingIds.has(ROOT_ID) && (
            <div className="absolute bottom-2 left-2 rounded-lg border border-border bg-surface-raised/90 px-2 py-1 text-[13px] text-text-muted">
              Loading…
            </div>
          )}
          {isEmpty && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-text-muted">
              {error ? "The graph isn't available right now." : "Nothing to show yet"}
            </div>
          )}
        </section>

        <aside className="space-y-2 overflow-auto rounded-xl border border-border bg-surface-raised p-3 text-sm">
          <h2 className="text-sm font-semibold text-text">Preview</h2>
          {preview.status === "idle" && (
            <p className="text-[13px] text-text-muted">Click a document to read it here.</p>
          )}
          {preview.status === "loading" && (
            <p className="text-[13px] text-text-muted">Loading…</p>
          )}
          {preview.status === "error" && (
            <p className="rounded-lg border border-status-rejected-border bg-status-rejected-surface p-2 text-[13px] text-status-rejected-text">
              {preview.message}
            </p>
          )}
          {preview.status === "ready" && preview.data.kind === "corpus_document" && (
            <div className="space-y-2">
              <div className="text-sm font-semibold text-text">{preview.data.title}</div>
              <div className="text-[13px] text-text-muted">
                {preview.data.ministry}
                {preview.data.date ? ` · ${formatDateIST(preview.data.date)}` : ""}
              </div>
              <div className="flex flex-wrap gap-1">
                {preview.data.domains.map((d) => (
                  <span
                    key={d}
                    className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-text-muted"
                  >
                    {d}
                  </span>
                ))}
              </div>
              <div className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-sunken p-2 text-[13px] text-text">
                {preview.data.text}
              </div>
            </div>
          )}
          {preview.status === "ready" && preview.data.kind === "draft" && (
            <div className="space-y-2">
              <p className="text-[13px] text-text-muted">
                This is an approved QCI document you can open.
              </p>
              <Link
                href={`/studio?open=${encodeURIComponent(preview.data.draft_id)}&persona=${encodeURIComponent(persona)}`}
                className="inline-block rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
              >
                Open document
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
