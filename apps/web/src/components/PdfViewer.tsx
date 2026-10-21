"use client";

import "pdfjs-dist/web/pdf_viewer.css";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { HighlightRect, ReaderHighlight } from "@/lib/cfcApi";

/* PDF.js's own types are loose across the library/viewer split; this
   component keeps them behind a small local surface instead. */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type PdfSource = { url: string; httpHeaders: Record<string, string>; withCredentials: boolean };

export type NewSelection = { page: number; rects: HighlightRect[]; quote: string };

export type PdfViewerHandle = {
  goToPage: (page: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitWidth: () => void;
  find: (query: string, again?: boolean) => void;
  showHighlight: (h: ReaderHighlight) => void;
};

type Props = {
  source: PdfSource;
  highlights: ReaderHighlight[];
  initialPage?: number;
  /** Text to find and mark once the document opens (e.g. a cited passage). */
  initialFind?: string;
  onSelect: (sel: NewSelection) => void;
  onHighlightClick: (id: number, at: { x: number; y: number }) => void;
  onLoaded: (info: { pages: number }) => void;
  onPageChange: (page: number) => void;
  onScaleChange?: (scale: number) => void;
  onError: (message: string) => void;
};

const ASSETS = "/pdfjs/";
const LAYER = "cfc-hl-layer";

function pageOf(el: Element | null): { div: HTMLElement; page: number } | null {
  const div = el?.closest(".page") as HTMLElement | null;
  const page = Number(div?.dataset.pageNumber);
  return div && page ? { div, page } : null;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** Widens a selection so it never starts or ends partway through a word. */
function snapToWords(sel: Selection) {
  if (!sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  const start = range.startContainer;
  if (start.nodeType === Node.TEXT_NODE) {
    const text = (start as Text).data;
    let o = range.startOffset;
    while (o > 0 && WORD_CHAR.test(text[o - 1])) o--;
    range.setStart(start, o);
  }
  const end = range.endContainer;
  if (end.nodeType === Node.TEXT_NODE) {
    const text = (end as Text).data;
    let o = range.endOffset;
    while (o < text.length && WORD_CHAR.test(text[o])) o++;
    range.setEnd(end, o);
  }
}

/** Client rects of a selection, as page fractions, one entry per line. */
function selectionRects(sel: Selection): HighlightRect[] {
  const raw: HighlightRect[] = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    for (const r of Array.from(sel.getRangeAt(i).getClientRects())) {
      if (r.width < 1 || r.height < 1) continue;
      const hit = pageOf(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      if (!hit) continue;
      const pr = hit.div.getBoundingClientRect();
      const rect = {
        page: hit.page,
        x: (r.left - pr.left) / pr.width,
        y: (r.top - pr.top) / pr.height,
        w: r.width / pr.width,
        h: r.height / pr.height,
      };
      // Whole-layer rects (the text layer's end-of-content helper) aren't text.
      if (rect.h > 0.15 || rect.w > 0.98) continue;
      raw.push(rect);
    }
  }
  raw.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const lines: HighlightRect[] = [];
  for (const r of raw) {
    const last = lines[lines.length - 1];
    const sameLine = last && last.page === r.page && Math.abs(last.y - r.y) < Math.min(last.h, r.h) * 0.5;
    if (sameLine && r.x <= last.x + last.w + 0.02) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

export const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerDivRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any>(null);
  const eventBusRef = useRef<any>(null);
  const highlightsRef = useRef<ReaderHighlight[]>(props.highlights);
  const propsRef = useRef(props);
  propsRef.current = props;

  const paintPage = useCallback((page: number) => {
    const view = viewerRef.current?.getPageView(page - 1);
    const div: HTMLElement | undefined = view?.div;
    if (!div) return;
    let layer = div.querySelector(`.${LAYER}`) as HTMLElement | null;
    if (!layer) {
      layer = document.createElement("div");
      layer.className = LAYER;
      const textLayer = div.querySelector(".textLayer");
      div.insertBefore(layer, textLayer ?? null);
    }
    layer.replaceChildren();
    for (const h of highlightsRef.current) {
      for (const r of h.rects) {
        if (r.page !== page) continue;
        const el = document.createElement("div");
        el.className = "cfc-hl";
        el.dataset.hlId = String(h.id);
        el.style.left = `${r.x * 100}%`;
        el.style.top = `${r.y * 100}%`;
        el.style.width = `${r.w * 100}%`;
        el.style.height = `${r.h * 100}%`;
        layer.appendChild(el);
      }
    }
  }, []);

  const paintAll = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    for (let i = 1; i <= viewer.pagesCount; i++) paintPage(i);
  }, [paintPage]);

  useEffect(() => {
    highlightsRef.current = props.highlights;
    paintAll();
  }, [props.highlights, paintAll]);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: any = null;
    (async () => {
      try {
        const pdfjsLib: any = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;
        (globalThis as any).pdfjsLib = pdfjsLib; // pdf_viewer.mjs reads the library from here
        const viewerLib: any = await import("pdfjs-dist/web/pdf_viewer.mjs");
        if (cancelled || !containerRef.current || !viewerDivRef.current) return;

        const eventBus = new viewerLib.EventBus();
        const linkService = new viewerLib.PDFLinkService({ eventBus });
        const findController = new viewerLib.PDFFindController({ eventBus, linkService });
        const viewer = new viewerLib.PDFViewer({
          container: containerRef.current,
          viewer: viewerDivRef.current,
          eventBus,
          linkService,
          findController,
          textLayerMode: 1,
          annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
        });
        linkService.setViewer(viewer);
        viewerRef.current = viewer;
        eventBusRef.current = eventBus;

        eventBus.on("pagesinit", () => {
          viewer.currentScaleValue = "page-width";
          const p = propsRef.current;
          if (p.initialPage && p.initialPage > 1) viewer.currentPageNumber = p.initialPage;
          if (p.initialFind) {
            eventBus.dispatch("find", {
              source: null, type: "", query: p.initialFind, caseSensitive: false, entireWord: false,
              highlightAll: true, findPrevious: false, matchDiacritics: false,
            });
          }
        });
        eventBus.on("pagerendered", ({ pageNumber }: { pageNumber: number }) => paintPage(pageNumber));
        eventBus.on("textlayerrendered", ({ pageNumber }: { pageNumber: number }) => paintPage(pageNumber));
        eventBus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) =>
          propsRef.current.onPageChange(pageNumber),
        );
        eventBus.on("scalechanging", ({ scale }: { scale: number }) => propsRef.current.onScaleChange?.(scale));

        const { source } = propsRef.current;
        loadingTask = pdfjsLib.getDocument({
          url: source.url,
          httpHeaders: source.httpHeaders,
          withCredentials: source.withCredentials,
          cMapUrl: `${ASSETS}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${ASSETS}standard_fonts/`,
          wasmUrl: `${ASSETS}wasm/`,
          iccUrl: `${ASSETS}iccs/`,
          isEvalSupported: false, // CVE-2024-4367 hardening; fonts never compile to JS
          enableXfa: false,
        });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        viewer.setDocument(pdf);
        linkService.setDocument(pdf, null);
        propsRef.current.onLoaded({ pages: pdf.numPages });
      } catch (e: any) {
        if (cancelled) return;
        const status = e?.status;
        propsRef.current.onError(
          status === 404
            ? "This document can't be shown here yet."
            : status === 401 || status === 403
              ? "You don't have access to this document."
              : "The document couldn't be opened. Please try again.",
        );
      }
    })();
    return () => {
      cancelled = true;
      try {
        viewerRef.current?.setDocument(null);
      } catch {
        /* viewer already torn down */
      }
      void loadingTask?.destroy();
      viewerRef.current = null;
      eventBusRef.current = null;
    };
  }, [props.source.url, paintPage]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: MouseEvent) => {
      const moved = downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 3 : false;
      window.setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && container.contains(sel.anchorNode)) snapToWords(sel);
        const quote = sel?.toString().trim() ?? "";
        if (sel && !sel.isCollapsed && quote.length > 1 && container.contains(sel.anchorNode)) {
          const rects = selectionRects(sel);
          if (rects.length) {
            propsRef.current.onSelect({ page: rects[0].page, rects, quote });
            sel.removeAllRanges();
          }
          return;
        }
        if (moved) return;
        // A plain click: did it land on one of the highlights?
        const hit = pageOf(document.elementFromPoint(e.clientX, e.clientY));
        if (!hit) return;
        const pr = hit.div.getBoundingClientRect();
        const px = (e.clientX - pr.left) / pr.width;
        const py = (e.clientY - pr.top) / pr.height;
        const found = highlightsRef.current.find((h) =>
          h.rects.some((r) => r.page === hit.page && px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h),
        );
        if (found) propsRef.current.onHighlightClick(found.id, { x: e.clientX, y: e.clientY });
      }, 0);
    };
    container.addEventListener("mousedown", onDown);
    container.addEventListener("mouseup", onUp);
    return () => {
      container.removeEventListener("mousedown", onDown);
      container.removeEventListener("mouseup", onUp);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    goToPage: (page) => {
      if (viewerRef.current) viewerRef.current.currentPageNumber = page;
    },
    zoomIn: () => viewerRef.current?.increaseScale(),
    zoomOut: () => viewerRef.current?.decreaseScale(),
    fitWidth: () => {
      if (viewerRef.current) viewerRef.current.currentScaleValue = "page-width";
    },
    find: (query, again = false) =>
      eventBusRef.current?.dispatch("find", {
        source: null, type: again ? "again" : "", query, caseSensitive: false, entireWord: false,
        highlightAll: true, findPrevious: false, matchDiacritics: false,
      }),
    showHighlight: (h) => {
      const viewer = viewerRef.current;
      const container = containerRef.current;
      const first = h.rects[0];
      if (!viewer || !container || !first) return;
      const view = viewer.getPageView(first.page - 1);
      if (!view?.div) return;
      container.scrollTo({ top: view.div.offsetTop + first.y * view.div.clientHeight - 140, behavior: "smooth" });
      window.setTimeout(() => {
        container.querySelectorAll(`.cfc-hl[data-hl-id="${h.id}"]`).forEach((el) => {
          el.classList.remove("cfc-hl-flash");
          void (el as HTMLElement).offsetWidth;
          el.classList.add("cfc-hl-flash");
        });
      }, 400);
    },
  }));

  return (
    <div ref={containerRef} className="cfc-pdf-container absolute inset-0 overflow-auto bg-surface-sunken">
      <div ref={viewerDivRef} className="pdfViewer" />
    </div>
  );
});
